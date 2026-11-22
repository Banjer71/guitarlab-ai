import json
import re
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi import File, HTTPException, UploadFile
from fastapi.responses import FileResponse

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SONGS_DIRECTORY = PROJECT_ROOT / "storage" / "songs"
METADATA_DIRECTORY = SONGS_DIRECTORY / "metadata"
MAX_UPLOAD_SIZE = 50 * 1024 * 1024
CHUNK_SIZE = 1024 * 1024

ALLOWED_AUDIO_TYPES = {
    ".mp3": {"audio/mpeg"},
    ".wav": {"audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"},
}

app = FastAPI(
    title="GuitarLab AI",
    description="AI-powered guitar learning and practice assistant",
    version="0.1.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def home():
    return {
        "message": "Welcome to GuitarLab AI!",
        "status": "running",
        "version": "0.1.0"
    }


@app.get("/health")
def health_check():
    return {"status": "healthy"}


@app.get("/songs")
def list_songs():
    songs = []

    if not METADATA_DIRECTORY.exists():
        return songs

    for metadata_path in METADATA_DIRECTORY.glob("*.json"):
        try:
            with metadata_path.open(encoding="utf-8") as metadata_file:
                song = json.load(metadata_file)

            if not isinstance(song, dict):
                continue

            required_fields = (
                "id",
                "original_filename",
                "stored_filename",
                "size_bytes",
                "content_type",
            )
            if any(field not in song for field in required_fields):
                continue

            uploaded_at = song.get("uploaded_at")
            if not isinstance(uploaded_at, str):
                continue

            sort_datetime = datetime.fromisoformat(uploaded_at)
            if sort_datetime.tzinfo is None:
                continue
            song["_sort_datetime"] = sort_datetime
            songs.append(song)
        except (OSError, json.JSONDecodeError, TypeError, ValueError):
            # Ignore corrupt or unreadable metadata so other songs remain available.
            continue

    songs.sort(key=lambda song: song.pop("_sort_datetime"), reverse=True)
    return songs


@app.get("/songs/{song_id}/audio")
def get_song_audio(song_id: str):
    if re.fullmatch(r"[0-9a-fA-F]{32}", song_id) is None:
        raise HTTPException(status_code=400, detail="Invalid song ID.")

    song_id = song_id.lower()
    metadata_path = METADATA_DIRECTORY / f"{song_id}.json"
    try:
        with metadata_path.open(encoding="utf-8") as metadata_file:
            metadata = json.load(metadata_file)
    except (OSError, json.JSONDecodeError):
        raise HTTPException(status_code=404, detail="Song not found.") from None

    required_fields = {
        "id",
        "original_filename",
        "stored_filename",
        "size_bytes",
        "content_type",
        "uploaded_at",
    }
    if not isinstance(metadata, dict) or not required_fields.issubset(metadata):
        raise HTTPException(status_code=404, detail="Song metadata is invalid.")

    stored_filename = metadata["stored_filename"]
    if (
        metadata["id"] != song_id
        or not isinstance(stored_filename, str)
        or Path(stored_filename).name != stored_filename
        or "/" in stored_filename
        or "\\" in stored_filename
    ):
        raise HTTPException(status_code=404, detail="Song metadata is invalid.")

    extension = Path(stored_filename).suffix.lower()
    if extension not in ALLOWED_AUDIO_TYPES or stored_filename != f"{song_id}{extension}":
        raise HTTPException(status_code=404, detail="Song metadata is invalid.")

    content_type = metadata["content_type"]
    if not isinstance(content_type, str) or content_type not in ALLOWED_AUDIO_TYPES[extension]:
        raise HTTPException(status_code=404, detail="Song metadata is invalid.")

    if (
        not isinstance(metadata["original_filename"], str)
        or not isinstance(metadata["size_bytes"], int)
        or isinstance(metadata["size_bytes"], bool)
        or not isinstance(metadata["uploaded_at"], str)
    ):
        raise HTTPException(status_code=404, detail="Song metadata is invalid.")

    try:
        datetime.fromisoformat(metadata["uploaded_at"])
    except ValueError:
        raise HTTPException(status_code=404, detail="Song metadata is invalid.") from None

    songs_root = SONGS_DIRECTORY.resolve()
    try:
        audio_path = (SONGS_DIRECTORY / stored_filename).resolve(strict=True)
    except OSError:
        raise HTTPException(status_code=404, detail="Song audio file not found.") from None

    if not audio_path.is_relative_to(songs_root) or not audio_path.is_file():
        raise HTTPException(status_code=404, detail="Song audio file not found.")

    return FileResponse(audio_path, media_type=content_type)


@app.post("/songs/upload", status_code=201)
async def upload_song(file: UploadFile = File(...)):
    original_filename = file.filename or ""
    extension = Path(original_filename.replace("\\", "/")).suffix.lower()
    content_type = (file.content_type or "").lower()

    if extension not in ALLOWED_AUDIO_TYPES:
        raise HTTPException(
            status_code=415,
            detail="Unsupported file extension. Only MP3 and WAV files are allowed.",
        )

    if content_type not in ALLOWED_AUDIO_TYPES[extension]:
        raise HTTPException(
            status_code=415,
            detail="The file MIME type does not match its extension or is unsupported.",
        )

    SONGS_DIRECTORY.mkdir(parents=True, exist_ok=True)
    stored_filename = f"{uuid4().hex}{extension}"
    destination = SONGS_DIRECTORY / stored_filename
    size_bytes = 0
    created_file = False

    try:
        # Exclusive creation ensures an existing recording is never overwritten.
        with destination.open("xb") as output_file:
            created_file = True
            while chunk := await file.read(CHUNK_SIZE):
                size_bytes += len(chunk)
                if size_bytes > MAX_UPLOAD_SIZE:
                    raise HTTPException(
                        status_code=413,
                        detail="File is too large. Maximum upload size is 50 MB.",
                    )
                output_file.write(chunk)
    except Exception:
        if created_file:
            destination.unlink(missing_ok=True)
        raise
    finally:
        await file.close()

    song_id = stored_filename.rsplit(".", 1)[0]
    uploaded_at = datetime.now(timezone.utc).isoformat()
    metadata = {
        "id": song_id,
        "original_filename": original_filename,
        "stored_filename": stored_filename,
        "size_bytes": size_bytes,
        "content_type": content_type,
        "uploaded_at": uploaded_at,
    }
    metadata_path = METADATA_DIRECTORY / f"{song_id}.json"

    try:
        METADATA_DIRECTORY.mkdir(parents=True, exist_ok=True)
        with metadata_path.open("x", encoding="utf-8") as metadata_file:
            json.dump(metadata, metadata_file, indent=2)
    except Exception as error:
        destination.unlink(missing_ok=True)
        metadata_path.unlink(missing_ok=True)
        raise HTTPException(
            status_code=500,
            detail="Could not save song metadata; the uploaded audio was removed.",
        ) from error

    return {
        "id": song_id,
        "original_filename": original_filename,
        "stored_filename": stored_filename,
        "size_bytes": size_bytes,
        "content_type": content_type,
    }

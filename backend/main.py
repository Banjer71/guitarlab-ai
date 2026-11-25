import json
import math
import os
import re
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi import File, HTTPException, UploadFile
from fastapi.responses import FileResponse

try:
    from .waveforms import (
        AudioProcessingTimeoutError,
        FFmpegUnavailableError,
        InvalidAudioError,
        MAX_ALLOWED_PEAKS,
        WAVEFORM_VERSION,
        WaveformGenerationError,
        generate_waveform,
    )
except ImportError:
    from waveforms import (
        AudioProcessingTimeoutError,
        FFmpegUnavailableError,
        InvalidAudioError,
        MAX_ALLOWED_PEAKS,
        WAVEFORM_VERSION,
        WaveformGenerationError,
        generate_waveform,
    )

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SONGS_DIRECTORY = PROJECT_ROOT / "storage" / "songs"
METADATA_DIRECTORY = SONGS_DIRECTORY / "metadata"
WAVEFORMS_DIRECTORY = PROJECT_ROOT / "storage" / "waveforms"
MAX_WAVEFORM_JSON_BYTES = 64 * 1024
MAX_UPLOAD_SIZE = 50 * 1024 * 1024
CHUNK_SIZE = 1024 * 1024
_WAVEFORM_LOCKS: dict[str, threading.Lock] = {}
_WAVEFORM_LOCKS_GUARD = threading.Lock()

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


@app.delete("/songs/{song_id}")
def delete_song(song_id: str):
    if re.fullmatch(r"[0-9a-fA-F]{32}", song_id) is None:
        raise HTTPException(status_code=400, detail="Invalid song ID.")

    song_id = song_id.lower()
    metadata_path = METADATA_DIRECTORY / f"{song_id}.json"
    try:
        songs_root = SONGS_DIRECTORY.resolve(strict=True)
        metadata_root = METADATA_DIRECTORY.resolve(strict=True)
        resolved_metadata_path = metadata_path.resolve(strict=True)
    except (OSError, RuntimeError):
        raise HTTPException(status_code=404, detail="Song not found.") from None

    if (
        not metadata_root.is_relative_to(songs_root)
        or not resolved_metadata_path.is_relative_to(metadata_root)
        or resolved_metadata_path.name != metadata_path.name
        or not resolved_metadata_path.is_file()
    ):
        raise HTTPException(status_code=404, detail="Song metadata path is invalid.")

    # Share the waveform endpoint's metadata validation and audio path checks.
    with _waveform_lock(song_id):
        _, audio_path = _resolve_waveform_source(song_id)

        waveform_path = WAVEFORMS_DIRECTORY / f"{song_id}.json"
        try:
            waveform_root = WAVEFORMS_DIRECTORY.resolve()
            if waveform_path.exists() or waveform_path.is_symlink():
                resolved_waveform_path = waveform_path.resolve(strict=True)
                if (
                    not resolved_waveform_path.is_relative_to(waveform_root)
                    or resolved_waveform_path.name != waveform_path.name
                    or not resolved_waveform_path.is_file()
                ):
                    raise HTTPException(status_code=404, detail="Cached waveform path is invalid.")
        except HTTPException:
            raise
        except (OSError, RuntimeError):
            raise HTTPException(status_code=404, detail="Cached waveform path is invalid.") from None

        try:
            if waveform_path.exists() or waveform_path.is_symlink():
                waveform_path.unlink()
            (SONGS_DIRECTORY / audio_path.name).unlink()
            metadata_path.unlink()
        except FileNotFoundError:
            raise HTTPException(status_code=404, detail="Song files were not found during deletion.") from None
        except OSError as error:
            raise HTTPException(status_code=500, detail="Could not delete the song files.") from error

    return {"message": "Song deleted successfully."}


def _resolve_waveform_source(song_id: str) -> tuple[str, Path]:
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
    except (OSError, RuntimeError):
        raise HTTPException(status_code=404, detail="Song audio file not found.") from None

    if not audio_path.is_relative_to(songs_root) or not audio_path.is_file():
        raise HTTPException(status_code=404, detail="Song audio file not found.")

    return song_id, audio_path


def _is_valid_waveform(waveform: object) -> bool:
    if not isinstance(waveform, dict):
        return False

    version = waveform.get("version")
    duration_seconds = waveform.get("duration_seconds")
    peaks = waveform.get("peaks")
    if (
        not isinstance(version, int)
        or isinstance(version, bool)
        or version != WAVEFORM_VERSION
        or not isinstance(duration_seconds, (int, float))
        or isinstance(duration_seconds, bool)
        or not isinstance(peaks, list)
        or not 0 < len(peaks) <= MAX_ALLOWED_PEAKS
    ):
        return False

    try:
        duration_is_valid = math.isfinite(duration_seconds) and duration_seconds > 0
    except OverflowError:
        return False

    return (
        duration_is_valid
        and all(
            isinstance(peak, int)
            and not isinstance(peak, bool)
            and 0 <= peak <= 255
            for peak in peaks
        )
    )


def _load_cached_waveform(waveform_path: Path) -> dict | None:
    try:
        resolved_path = waveform_path.resolve(strict=True)
    except FileNotFoundError:
        return None
    except (OSError, RuntimeError):
        return None

    if not resolved_path.is_relative_to(WAVEFORMS_DIRECTORY.resolve()) or not resolved_path.is_file():
        return None

    try:
        with resolved_path.open("rb") as waveform_file:
            serialized_waveform = waveform_file.read(MAX_WAVEFORM_JSON_BYTES + 1)
    except FileNotFoundError:
        return None
    except OSError as error:
        raise HTTPException(status_code=500, detail="Could not read cached waveform data.") from error

    if len(serialized_waveform) > MAX_WAVEFORM_JSON_BYTES:
        return None
    try:
        waveform = json.loads(serialized_waveform)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None

    return waveform if _is_valid_waveform(waveform) else None


def _write_waveform_atomically(waveform_path: Path, waveform: dict) -> None:
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=WAVEFORMS_DIRECTORY,
            prefix=f".{waveform_path.stem}.",
            suffix=".tmp",
            delete=False,
        ) as temporary_file:
            temporary_path = Path(temporary_file.name)
            json.dump(waveform, temporary_file, separators=(",", ":"))
            temporary_file.flush()
            os.fsync(temporary_file.fileno())

        os.replace(temporary_path, waveform_path)
    except OSError as error:
        raise HTTPException(status_code=500, detail="Could not save waveform data.") from error
    finally:
        if temporary_path is not None:
            try:
                temporary_path.unlink(missing_ok=True)
            except OSError:
                pass


def _waveform_lock(song_id: str) -> threading.Lock:
    """Return the process-local generation lock for one song."""
    with _WAVEFORM_LOCKS_GUARD:
        lock = _WAVEFORM_LOCKS.get(song_id)
        if lock is None:
            lock = threading.Lock()
            _WAVEFORM_LOCKS[song_id] = lock
        return lock


@app.get("/songs/{song_id}/waveform")
def get_song_waveform(song_id: str):
    song_id, audio_path = _resolve_waveform_source(song_id)
    waveform_path = WAVEFORMS_DIRECTORY / f"{song_id}.json"

    try:
        WAVEFORMS_DIRECTORY.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        raise HTTPException(status_code=500, detail="Could not access waveform storage.") from error

    cached_waveform = _load_cached_waveform(waveform_path)
    if cached_waveform is not None:
        return cached_waveform

    with _waveform_lock(song_id):
        # Another request may have populated the cache while this request waited.
        cached_waveform = _load_cached_waveform(waveform_path)
        if cached_waveform is not None:
            return cached_waveform

        try:
            waveform = generate_waveform(audio_path)
        except FFmpegUnavailableError as error:
            raise HTTPException(status_code=503, detail="Waveform generation is unavailable.") from error
        except AudioProcessingTimeoutError as error:
            raise HTTPException(status_code=504, detail="Waveform generation timed out.") from error
        except InvalidAudioError as error:
            raise HTTPException(status_code=422, detail="Waveform could not be generated for this audio file.") from error
        except WaveformGenerationError as error:
            raise HTTPException(status_code=500, detail="Waveform generation failed.") from error

        if not _is_valid_waveform(waveform):
            raise HTTPException(status_code=500, detail="Waveform generator returned invalid data.")

        _write_waveform_atomically(waveform_path, waveform)
        return waveform


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

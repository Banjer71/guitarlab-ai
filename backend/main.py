from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi import File, HTTPException, UploadFile

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SONGS_DIRECTORY = PROJECT_ROOT / "storage" / "songs"
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

    return {
        "id": stored_filename.rsplit(".", 1)[0],
        "original_filename": original_filename,
        "stored_filename": stored_filename,
        "size_bytes": size_bytes,
        "content_type": content_type,
    }

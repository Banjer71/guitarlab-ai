# GuitarLab AI

GuitarLab AI is a learning and practice studio for guitarists. The project aims to help you work with songs, focus on guitar parts, study tablature and licks, and compare your playing with a reference recording. The current version is an early starter: it has a basic dashboard and a backend health check, while the planned audio learning features are still to be built.

## Technology stack

- **Frontend:** React, TypeScript and Vite
- **Backend:** Python and FastAPI
- **Python environment:** `backend/.venv/`
- **Audio tools:** FFmpeg is planned for audio processing; it is not currently connected to the application
- **Version control:** Git

## Project folders

```text
guitarlab-ai/
├── backend/
│   ├── .venv/          # Local Python virtual environment (ignored by Git)
│   └── main.py         # FastAPI application
├── frontend/
│   ├── src/            # React and TypeScript application
│   ├── public/         # Static frontend files
│   └── package.json    # Frontend scripts and dependencies
├── storage/
│   ├── exercises/     # Space for practice exercises
│   ├── recordings/    # Space for imported or recorded audio
│   ├── songs/         # Space for song files
│   └── stems/         # Space for separated audio tracks
├── .gitignore
└── README.md
```

Audio files created or placed under `storage/` are ignored by Git. The `.gitkeep` files preserve the empty storage folders in the repository.

## Run the backend

Open a terminal at the project root, then activate the existing Python virtual environment:

```bash
source backend/.venv/bin/activate
```

On Windows PowerShell, use:

```powershell
backend\.venv\Scripts\Activate.ps1
```

With the environment active, start FastAPI from the project root:

```bash
uvicorn main:app --reload --app-dir backend
```

The backend runs at <http://127.0.0.1:8000>. Its interactive API page is at <http://127.0.0.1:8000/docs>.

## Run the frontend

Open a second terminal at the project root and start Vite:

```bash
cd frontend
npm run dev
```

Open the local address printed by Vite (usually <http://localhost:5173>) in your browser. The dashboard checks the backend at <http://127.0.0.1:8000/health>, so start the backend as well to see it report a healthy connection.

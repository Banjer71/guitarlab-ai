import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import './App.css'

type SongUploadResponse = {
  id: string;
  original_filename: string;
  stored_filename: string;
  size_bytes: number;
  content_type: string;
};

const MAX_UPLOAD_SIZE = 50 * 1024 * 1024;

function formatFileSize(sizeBytes: number) {
  return `${(sizeBytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function App() {
    const [backendStatus, setBackendStatus] = useState("Checking...");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadMessage, setUploadMessage] = useState("");
  const [uploadError, setUploadError] = useState("");

  useEffect(() => {
    fetch("http://127.0.0.1:8000/health")
      .then((response) => {
        if (!response.ok) {
          throw new Error("Backend unavailable");
        }
        return response.json();
      })
      .then((data) => setBackendStatus(data.status))
      .catch(() => setBackendStatus("Disconnected"));
  }, []);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    setSelectedFile(null);
    setUploadMessage("");
    setUploadError("");
    setUploadProgress(null);

    if (!file) return;

    const extension = file.name.split(".").pop()?.toLowerCase();
    if (extension !== "mp3" && extension !== "wav") {
      setUploadError("Choose an MP3 or WAV audio file.");
      event.target.value = "";
      return;
    }

    if (file.size > MAX_UPLOAD_SIZE) {
      setUploadError("The file is too large. Maximum upload size is 50 MiB.");
      event.target.value = "";
      return;
    }

    setSelectedFile(file);
  }

  function handleUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedFile || uploading) return;

    setUploading(true);
    setUploadProgress(0);
    setUploadMessage("");
    setUploadError("");

    const formData = new FormData();
    formData.append("file", selectedFile);

    const request = new XMLHttpRequest();
    request.open("POST", "http://127.0.0.1:8000/songs/upload");
    request.upload.addEventListener("progress", (progressEvent) => {
      if (progressEvent.lengthComputable) {
        setUploadProgress(Math.round((progressEvent.loaded / progressEvent.total) * 100));
      }
    });
    request.addEventListener("load", () => {
      setUploading(false);
      if (request.status === 201) {
        const result = JSON.parse(request.responseText) as SongUploadResponse;
        setUploadProgress(100);
        setUploadMessage(`Uploaded “${result.original_filename}” successfully.`);
        return;
      }

      let detail = "The upload could not be completed. Please try again.";
      if (request.status === 413) {
        detail = "The file is too large. Maximum upload size is 50 MiB.";
      } else if (request.status === 415) {
        detail = "Unsupported file format. Choose an MP3 or WAV file.";
      }
      try {
        const response = JSON.parse(request.responseText) as { detail?: string };
        if (response.detail) detail = response.detail;
      } catch { /* Use the status-specific message when the response is not JSON. */ }
      setUploadError(detail);
    });
    request.addEventListener("error", () => {
      setUploading(false);
      setUploadError("Could not connect to the backend. Check that it is running and try again.");
    });
    request.addEventListener("abort", () => {
      setUploading(false);
      setUploadError("The upload was cancelled.");
    });
    request.send(formData);
  }


  return (
    <div className="app">
      <header className="header">
        <h1>🎸 GuitarLab AI</h1>
        <span>AI-powered guitar learning studio</span>
      </header>

      <main className="dashboard">
        <section className="welcome">
          <h2>Welcome to your practice studio</h2>
          <p>
            Analyse songs, isolate guitar tracks and improve your playing
            with AI.
          </p>
        </section>

        <section className="features">
          <div className="feature-card">
            <h3>🎵 Song Library</h3>
            <p>Import and manage your favourite songs.</p>
          </div>

          <div className="feature-card">
            <h3>🎚️ Audio Workspace</h3>
            <p>Slow down, loop and analyse recordings.</p>
          </div>

          <div className="feature-card">
            <h3>🎸 Guitar Stems</h3>
            <p>Separate guitar, bass, drums and vocals.</p>
          </div>

          <div className="feature-card">
            <h3>📖 Practice Studio</h3>
            <p>Save licks, study tablature and create exercises.</p>
          </div>
        </section>

        <section className="upload-card" aria-labelledby="upload-heading">
          <h3 id="upload-heading">Upload a song</h3>
          <p className="upload-description">Choose an MP3 or WAV file up to 50 MiB to add it to your song library.</p>
          <form onSubmit={handleUpload}>
            <label className="file-picker">
              <span>Select audio file</span>
              <input
                type="file"
                accept=".mp3,.wav,audio/mpeg,audio/wav"
                onChange={handleFileChange}
                disabled={uploading}
              />
            </label>
            {selectedFile && (
              <p className="selected-file">
                {selectedFile.name} <span>({formatFileSize(selectedFile.size)})</span>
              </p>
            )}
            <button className="upload-button" type="submit" disabled={!selectedFile || uploading}>
              {uploading ? "Uploading…" : "Upload"}
            </button>
          </form>
          {uploadProgress !== null && (
            <div className="upload-progress" aria-live="polite">
              <progress value={uploadProgress} max="100" />
              <span>{uploadProgress}%</span>
            </div>
          )}
          {uploadMessage && <p className="upload-success" role="status">{uploadMessage}</p>}
          {uploadError && <p className="upload-error" role="alert">{uploadError}</p>}
        </section>

        <section className="status">
          <h3>System status</h3>
          <p>Frontend: Running</p>
          <p>Backend: {backendStatus}</p>
        </section>
      </main>
    </div>
  );
}

export default App;

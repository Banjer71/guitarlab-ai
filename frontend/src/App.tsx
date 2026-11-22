import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import './App.css'

interface Song {
  id: string;
  original_filename: string;
  stored_filename: string;
  size_bytes: number;
  content_type: string;
  uploaded_at: string;
}

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

function formatUploadDate(uploadedAt: string) {
  return new Date(uploadedAt).toLocaleString();
}

function getSongFormat(song: Song) {
  return song.original_filename.split(".").pop()?.toUpperCase() ?? "Audio";
}

function formatTime(seconds: number) {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function App() {
  const [backendStatus, setBackendStatus] = useState("Checking...");
  const [songs, setSongs] = useState<Song[]>([]);
  const [songsLoading, setSongsLoading] = useState(true);
  const [songsError, setSongsError] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadMessage, setUploadMessage] = useState("");
  const [uploadError, setUploadError] = useState("");
  const audioRef = useRef<HTMLAudioElement>(null);
  const playbackRateRef = useRef(1);
  const [currentSong, setCurrentSong] = useState<Song | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isAudioLoading, setIsAudioLoading] = useState(false);
  const [playbackError, setPlaybackError] = useState("");
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState<number | null>(null);
  const [playbackRate, setPlaybackRate] = useState(1);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    const handleEnded = () => setIsPlaying(false);
    const handleLoading = () => setIsAudioLoading(true);
    const handleReady = () => setIsAudioLoading(false);
    const handleTimeUpdate = () => {
      if (Number.isFinite(audio.currentTime)) setCurrentTime(audio.currentTime);
    };
    const updateDuration = () => {
      audio.playbackRate = playbackRateRef.current;
      setDuration(
        audio.readyState >= HTMLMediaElement.HAVE_METADATA && Number.isFinite(audio.duration)
          ? audio.duration
          : null,
      );
      if (Number.isFinite(audio.currentTime)) setCurrentTime(audio.currentTime);
    };
    const handleError = () => {
      setIsPlaying(false);
      setIsAudioLoading(false);
      setPlaybackError("Could not play this song. Check the backend connection and try again.");
    };

    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("ended", handleEnded);
    audio.addEventListener("loadstart", handleLoading);
    audio.addEventListener("waiting", handleLoading);
    audio.addEventListener("playing", handleReady);
    audio.addEventListener("canplay", handleReady);
    audio.addEventListener("error", handleError);
    audio.addEventListener("timeupdate", handleTimeUpdate);
    audio.addEventListener("loadedmetadata", updateDuration);
    audio.addEventListener("durationchange", updateDuration);

    return () => {
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("loadstart", handleLoading);
      audio.removeEventListener("waiting", handleLoading);
      audio.removeEventListener("playing", handleReady);
      audio.removeEventListener("canplay", handleReady);
      audio.removeEventListener("error", handleError);
      audio.removeEventListener("timeupdate", handleTimeUpdate);
      audio.removeEventListener("loadedmetadata", updateDuration);
      audio.removeEventListener("durationchange", updateDuration);
    };
  }, []);

  function playSong(song: Song) {
    const audio = audioRef.current;
    if (!audio) return;

    setCurrentSong(song);
    setPlaybackError("");
    setIsAudioLoading(true);
    setCurrentTime(0);
    setDuration(null);
    audio.pause();
    audio.src = `http://127.0.0.1:8000/songs/${encodeURIComponent(song.id)}/audio`;
    audio.load();
    audio.playbackRate = playbackRateRef.current;
    void audio.play().catch(() => {
      setIsPlaying(false);
      setIsAudioLoading(false);
      setPlaybackError("Playback could not start. Check the backend connection and try again.");
    });
  }

  function togglePlayback() {
    const audio = audioRef.current;
    if (!audio || !currentSong) return;

    if (audio.paused) {
      setPlaybackError("");
      setIsAudioLoading(true);
      void audio.play().catch(() => {
        setIsPlaying(false);
        setIsAudioLoading(false);
        setPlaybackError("Playback could not start. Check the backend connection and try again.");
      });
    } else {
      audio.pause();
    }
  }

  function handleSongButtonClick(song: Song) {
    if (currentSong?.id === song.id) {
      togglePlayback();
    } else {
      playSong(song);
    }
  }

  function handleSeek(event: ChangeEvent<HTMLInputElement>) {
    const audio = audioRef.current;
    const nextTime = Number(event.currentTarget.value);
    if (!audio || !Number.isFinite(nextTime) || duration === null) return;

    audio.currentTime = nextTime;
    setCurrentTime(nextTime);
  }

  function handlePlaybackRateChange(event: ChangeEvent<HTMLSelectElement>) {
    const nextRate = Number(event.currentTarget.value);
    const audio = audioRef.current;
    if (!Number.isFinite(nextRate)) return;

    playbackRateRef.current = nextRate;
    setPlaybackRate(nextRate);
    if (audio) audio.playbackRate = nextRate;
  }

  const fetchSongs = useCallback(async () => {
    setSongsLoading(true);
    setSongsError("");

    try {
      const response = await fetch("http://127.0.0.1:8000/songs");
      if (!response.ok) {
        throw new Error(`Could not load the song library (HTTP ${response.status}).`);
      }
      const songList = (await response.json()) as Song[];
      setSongs(songList);
    } catch {
      setSongsError("Could not load your song library. Check that the backend is running, then refresh.");
    } finally {
      setSongsLoading(false);
    }
  }, []);

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

  useEffect(() => {
    void fetchSongs();
  }, [fetchSongs]);

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
        void fetchSongs();
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

        <section className="song-library" aria-labelledby="library-heading">
          <div className="library-heading-row">
            <div>
              <h3 id="library-heading">Song Library</h3>
              <p className="library-description">Your uploaded songs, ready for future study.</p>
            </div>
            <button
              className="refresh-button"
              type="button"
              onClick={() => void fetchSongs()}
              disabled={songsLoading}
            >
              {songsLoading ? "Refreshing…" : "Refresh"}
            </button>
          </div>

          {songsLoading && <p className="library-message" role="status">Loading your song library…</p>}
          {songsError && <p className="library-error" role="alert">{songsError}</p>}
          {!songsLoading && !songsError && songs.length === 0 && (
            <p className="library-empty">No songs yet. Upload an MP3 or WAV file to get started.</p>
          )}
          {songs.length > 0 && (
            <ul className="song-list">
              {songs.map((song) => (
                <li className="song-item" key={song.id}>
                  <div className="song-row">
                    <div className="song-info">
                      <div className="song-name">{song.original_filename}</div>
                      <div className="song-details">
                        <span>{getSongFormat(song)}</span>
                        <span>{formatFileSize(song.size_bytes)}</span>
                        <span>Uploaded {formatUploadDate(song.uploaded_at)}</span>
                      </div>
                    </div>
                    <button
                      className="song-play-button"
                      type="button"
                      onClick={() => handleSongButtonClick(song)}
                    >
                      {currentSong?.id === song.id && isPlaying ? "Pause" : "Play"}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="player-card" aria-labelledby="player-heading">
          <h3 id="player-heading">Now playing</h3>
          <p className="player-song-name">{currentSong?.original_filename ?? "Select a song from your library."}</p>
          <div className="player-controls">
            <button className="player-control" type="button" onClick={togglePlayback} disabled={!currentSong}>
              {isAudioLoading ? "Loading…" : isPlaying ? "Pause" : "Play"}
            </button>
            <label className="playback-speed">
              <span>Speed</span>
              <select value={playbackRate} onChange={handlePlaybackRateChange} aria-label="Playback speed">
                <option value="1">1.0x</option>
                <option value="0.75">0.75x</option>
                <option value="0.5">0.5x</option>
              </select>
            </label>
          </div>
          <div className="playback-progress">
            <input
              className="playback-seek"
              type="range"
              min="0"
              max={duration ?? 0}
              step="0.1"
              value={duration === null ? 0 : Math.min(currentTime, duration)}
              onChange={handleSeek}
              disabled={!currentSong || duration === null || duration <= 0}
              aria-label="Seek through song"
            />
            <div className="playback-times" aria-live="off">
              <span>{formatTime(currentTime)}</span>
              <span>{duration === null ? "--:--" : formatTime(duration)}</span>
            </div>
          </div>
          {playbackError && <p className="playback-error" role="alert">{playbackError}</p>}
          <audio ref={audioRef} preload="none" />
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

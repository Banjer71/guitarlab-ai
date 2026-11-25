import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type MouseEvent } from "react";
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

type WaveformData = {
  version: number;
  duration_seconds: number;
  peaks: number[];
};

const API_BASE_URL = "http://127.0.0.1:8000";
const waveformCache = new Map<string, WaveformData>();
const WAVEFORM_BAR_SPACING_PX = 1.5;
const WAVEFORM_WINDOW_SECONDS = 15;
const WAVEFORM_BUFFER_SECONDS = 25;
const WAVEFORM_BUFFER_STEP_SECONDS = 5;
const WAVEFORM_UNITS_PER_SECOND = 1000 / WAVEFORM_WINDOW_SECONDS;

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

function formatTime(seconds: number, showTenths = false) {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  if (showTenths) {
    const totalTenths = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds * 10)) : 0;
    const tenthsMinutes = Math.floor(totalTenths / 600);
    const tenthsSeconds = Math.floor(totalTenths / 10) % 60;
    const tenths = totalTenths % 10;
    return `${String(tenthsMinutes).padStart(2, "0")}:${String(tenthsSeconds).padStart(2, "0")}.${tenths}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function getWaveformViewportStart(time: number, duration: number) {
  return Math.min(
    Math.max(0, time - WAVEFORM_WINDOW_SECONDS / 2),
    Math.max(0, duration - WAVEFORM_WINDOW_SECONDS),
  );
}

function getWaveformBufferStart(viewportStart: number, duration: number) {
  const steppedStart = Math.max(
    0,
    Math.floor(viewportStart / WAVEFORM_BUFFER_STEP_SECONDS) * WAVEFORM_BUFFER_STEP_SECONDS
      - WAVEFORM_BUFFER_STEP_SECONDS,
  );
  return Math.min(steppedStart, Math.max(0, duration - WAVEFORM_BUFFER_SECONDS));
}

function App() {
  const [backendStatus, setBackendStatus] = useState("Checking...");
  const [songs, setSongs] = useState<Song[]>([]);
  const [songsLoading, setSongsLoading] = useState(true);
  const [songsError, setSongsError] = useState("");
  const [deletingSongIds, setDeletingSongIds] = useState<Set<string>>(() => new Set());
  const [deleteError, setDeleteError] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadMessage, setUploadMessage] = useState("");
  const [uploadError, setUploadError] = useState("");
  const audioRef = useRef<HTMLAudioElement>(null);
  const deletingSongIdsRef = useRef(new Set<string>());
  const waveformSvgRef = useRef<SVGSVGElement>(null);
  const waveformGroupRef = useRef<SVGGElement>(null);
  const waveformClipRef = useRef<SVGRectElement>(null);
  const waveformCursorRef = useRef<SVGLineElement>(null);
  const waveformBufferStartRef = useRef(0);
  const waveformBufferUpdatePendingRef = useRef(false);
  const waveformViewportStartRef = useRef(0);
  const waveformDurationRef = useRef(0);
  const playbackRateRef = useRef(1);
  const loopStartRef = useRef<number | null>(null);
  const loopEndRef = useRef<number | null>(null);
  const [currentSong, setCurrentSong] = useState<Song | null>(null);
  const currentSongRef = useRef<Song | null>(null);
  currentSongRef.current = currentSong;
  const [isPlaying, setIsPlaying] = useState(false);
  const [isAudioLoading, setIsAudioLoading] = useState(false);
  const [playbackError, setPlaybackError] = useState("");
  const [currentTime, setCurrentTime] = useState(0);
  const [showTimeTenths, setShowTimeTenths] = useState(false);
  const [duration, setDuration] = useState<number | null>(null);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [loopStart, setLoopStart] = useState<number | null>(null);
  const [loopEnd, setLoopEnd] = useState<number | null>(null);
  const [loopError, setLoopError] = useState("");
  const [waveform, setWaveform] = useState<WaveformData | null>(null);
  const [waveformDisplayWidth, setWaveformDisplayWidth] = useState(0);
  const [waveformBufferStart, setWaveformBufferStart] = useState(0);
  const [waveformLoading, setWaveformLoading] = useState(false);
  const [waveformError, setWaveformError] = useState("");
  waveformDurationRef.current = waveform?.duration_seconds ?? 0;

  const updateWaveformPosition = useCallback((time: number, mediaDuration: number | null) => {
    const durationSeconds = mediaDuration !== null && mediaDuration > 0
      ? mediaDuration
      : waveformDurationRef.current;
    if (durationSeconds <= 0) return;

    const viewportStart = getWaveformViewportStart(time, durationSeconds);
    waveformViewportStartRef.current = viewportStart;
    const nextBufferStart = getWaveformBufferStart(viewportStart, durationSeconds);
    if (nextBufferStart !== waveformBufferStartRef.current) {
      waveformBufferStartRef.current = nextBufferStart;
      waveformBufferUpdatePendingRef.current = true;
      setWaveformBufferStart(nextBufferStart);
      return;
    }
    if (waveformBufferUpdatePendingRef.current) return;

    const viewportOffset = (viewportStart - waveformBufferStartRef.current) * WAVEFORM_UNITS_PER_SECOND;
    waveformGroupRef.current?.setAttribute("transform", `translate(${-viewportOffset} 0)`);
    if (waveformClipRef.current) {
      waveformClipRef.current.setAttribute(
        "width",
        String(Math.max(0, time - waveformBufferStartRef.current) * WAVEFORM_UNITS_PER_SECOND),
      );
    }
    if (waveformCursorRef.current) {
      const x = (time - viewportStart) * WAVEFORM_UNITS_PER_SECOND;
      waveformCursorRef.current.setAttribute("x1", String(x));
      waveformCursorRef.current.setAttribute("x2", String(x));
    }
  }, []);

  useLayoutEffect(() => {
    waveformBufferUpdatePendingRef.current = false;
    const audio = audioRef.current;
    const audioDuration = audio && Number.isFinite(audio.duration) ? audio.duration : duration;
    updateWaveformPosition(audio?.currentTime ?? currentTime, audioDuration);
  }, [currentTime, duration, updateWaveformPosition, waveform, waveformBufferStart]);

  useEffect(() => {
    const svg = waveformSvgRef.current;
    if (!svg) return;

    const resizeObserver = new ResizeObserver(([entry]) => {
      if (entry) setWaveformDisplayWidth(entry.contentRect.width);
    });
    resizeObserver.observe(svg);
    return () => resizeObserver.disconnect();
  }, [waveform]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    let animationFrame: number | null = null;
    const stopWaveformAnimation = () => {
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      animationFrame = null;
    };
    const animateWaveform = () => {
      if (audio.paused) {
        animationFrame = null;
        return;
      }
      updateWaveformPosition(audio.currentTime, Number.isFinite(audio.duration) ? audio.duration : null);
      animationFrame = requestAnimationFrame(animateWaveform);
    };
    const handlePlay = () => {
      setIsPlaying(true);
      if (animationFrame === null) animationFrame = requestAnimationFrame(animateWaveform);
    };
    const handlePause = () => {
      setIsPlaying(false);
      stopWaveformAnimation();
      updateWaveformPosition(audio.currentTime, Number.isFinite(audio.duration) ? audio.duration : null);
    };
    const handleEnded = () => {
      setIsPlaying(false);
      stopWaveformAnimation();
      updateWaveformPosition(audio.currentTime, Number.isFinite(audio.duration) ? audio.duration : null);
    };
    const handleLoading = () => setIsAudioLoading(true);
    const handleReady = () => setIsAudioLoading(false);
    const handleTimeUpdate = () => {
      if (!Number.isFinite(audio.currentTime)) return;

      const start = loopStartRef.current;
      const end = loopEndRef.current;
      if (start !== null && end !== null && audio.currentTime >= end) {
        audio.currentTime = start;
        setCurrentTime(start);
        updateWaveformPosition(start, audio.duration);
        return;
      }
      setCurrentTime(audio.currentTime);
      updateWaveformPosition(audio.currentTime, Number.isFinite(audio.duration) ? audio.duration : null);
    };
    const updateDuration = () => {
      audio.playbackRate = playbackRateRef.current;
      setDuration(
        audio.readyState >= HTMLMediaElement.HAVE_METADATA && Number.isFinite(audio.duration)
          ? audio.duration
          : null,
      );
      if (Number.isFinite(audio.currentTime)) setCurrentTime(audio.currentTime);
      updateWaveformPosition(audio.currentTime, Number.isFinite(audio.duration) ? audio.duration : null);
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
      stopWaveformAnimation();
    };
  }, [updateWaveformPosition]);

  useEffect(() => {
    if (!currentSong) {
      setWaveform(null);
      setWaveformLoading(false);
      setWaveformError("");
      return;
    }

    const cached = waveformCache.get(currentSong.id);
    if (cached) {
      setWaveform(cached);
      setWaveformLoading(false);
      setWaveformError("");
      return;
    }

    const controller = new AbortController();
    setWaveform(null);
    setWaveformLoading(true);
    setWaveformError("");
    fetch(`${API_BASE_URL}/songs/${encodeURIComponent(currentSong.id)}/waveform`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Waveform request failed (HTTP ${response.status}).`);
        return await response.json() as WaveformData;
      })
      .then((data) => {
        if (!Array.isArray(data.peaks) || !Number.isFinite(data.duration_seconds)) {
          throw new Error("Invalid waveform response.");
        }
        if (controller.signal.aborted) return;
        waveformCache.set(currentSong.id, data);
        setWaveform(data);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
        setWaveformError("Waveform unavailable. Audio playback is still available.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setWaveformLoading(false);
      });

    return () => controller.abort();
  }, [currentSong]);

  useEffect(() => {
    function handleKeyboardSeek(event: KeyboardEvent) {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (!currentSong || duration === null || duration <= 0) return;

      const target = event.target;
      if (target instanceof Element && (
        target.closest("input, textarea, select, button:not([data-playback-shortcut]), a, summary, audio, video, [contenteditable='true'], [role='button'], [role='slider'], [role='combobox'], [role='switch'], [role='checkbox'], [tabindex]:not([tabindex='-1']):not([data-playback-shortcut])")
        || (target instanceof HTMLElement && target.isContentEditable)
      )) return;

      const audio = audioRef.current;
      if (!audio) return;

      const direction = event.key === "ArrowLeft" ? -1 : 1;
      const step = event.shiftKey ? 0.1 : 1;
      let minimum = 0;
      let maximum = duration;
      const start = loopStartRef.current;
      const end = loopEndRef.current;
      if (start !== null && end !== null) {
        minimum = start;
        maximum = end;
      }

      const nextTime = Math.min(maximum, Math.max(minimum, audio.currentTime + direction * step));
      audio.currentTime = nextTime;
      setCurrentTime(nextTime);
      updateWaveformPosition(nextTime, duration);
      setShowTimeTenths(event.shiftKey);
      event.preventDefault();
    }

    window.addEventListener("keydown", handleKeyboardSeek);
    return () => window.removeEventListener("keydown", handleKeyboardSeek);
  }, [currentSong, duration, updateWaveformPosition]);

  function playSong(song: Song) {
    const audio = audioRef.current;
    if (!audio) return;

    setCurrentSong(song);
    setPlaybackError("");
    setIsAudioLoading(true);
    setCurrentTime(0);
    setDuration(null);
    loopStartRef.current = null;
    loopEndRef.current = null;
    setLoopStart(null);
    setLoopEnd(null);
    setLoopError("");
    waveformBufferStartRef.current = 0;
    waveformBufferUpdatePendingRef.current = false;
    waveformViewportStartRef.current = 0;
    setWaveformBufferStart(0);
    audio.pause();
    audio.src = `http://127.0.0.1:8000/songs/${encodeURIComponent(song.id)}/audio`;
    audio.load();
    updateWaveformPosition(0, null);
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

  function handleWaveformClick(event: MouseEvent<SVGSVGElement>) {
    const audio = audioRef.current;
    if (!audio || duration === null || duration <= 0) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0) return;
    const fraction = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
    let nextTime = waveformViewportStartRef.current + fraction * WAVEFORM_WINDOW_SECONDS;
    nextTime = Math.min(duration, Math.max(0, nextTime));
    const start = loopStartRef.current;
    const end = loopEndRef.current;
    if (start !== null && end !== null) nextTime = Math.min(end, Math.max(start, nextTime));
    audio.currentTime = nextTime;
    setCurrentTime(nextTime);
    setShowTimeTenths(false);
    updateWaveformPosition(nextTime, duration);
  }

  function handlePlaybackRateChange(event: ChangeEvent<HTMLSelectElement>) {
    const nextRate = Number(event.currentTarget.value);
    const audio = audioRef.current;
    if (!Number.isFinite(nextRate)) return;

    playbackRateRef.current = nextRate;
    setPlaybackRate(nextRate);
    if (audio) audio.playbackRate = nextRate;
  }

  function handleSetLoopStart() {
    const audio = audioRef.current;
    if (!audio || !currentSong || !Number.isFinite(audio.currentTime)) return;

    const nextStart = audio.currentTime;
    loopStartRef.current = nextStart;
    setLoopStart(nextStart);
    if (loopEndRef.current !== null && loopEndRef.current <= nextStart) {
      loopEndRef.current = null;
      setLoopEnd(null);
      setLoopError("Set B after A to create a valid loop.");
      return;
    }
    setLoopError("");
  }

  function handleSetLoopEnd() {
    const audio = audioRef.current;
    if (!audio || !currentSong || !Number.isFinite(audio.currentTime)) return;

    const nextEnd = audio.currentTime;
    if (loopStartRef.current === null || nextEnd <= loopStartRef.current) {
      setLoopError("Set B after A to create a valid loop.");
      return;
    }

    loopEndRef.current = nextEnd;
    setLoopEnd(nextEnd);
    setLoopError("");
  }

  function handleClearLoop() {
    loopStartRef.current = null;
    loopEndRef.current = null;
    setLoopStart(null);
    setLoopEnd(null);
    setLoopError("");
  }

  const fetchSongs = useCallback(async () => {
    setSongsLoading(true);
    setSongsError("");

    try {
      const response = await fetch(`${API_BASE_URL}/songs`);
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

  async function handleDeleteSong(song: Song) {
    if (deletingSongIdsRef.current.has(song.id)) return;
    if (!window.confirm(`Delete “${song.original_filename}”? This cannot be undone.`)) return;

    deletingSongIdsRef.current.add(song.id);
    setDeletingSongIds(new Set(deletingSongIdsRef.current));
    setDeleteError("");
    try {
      const response = await fetch(`${API_BASE_URL}/songs/${encodeURIComponent(song.id)}`, { method: "DELETE" });
      if (!response.ok) {
        let detail = `Could not delete “${song.original_filename}” (HTTP ${response.status}).`;
        try {
          const body = await response.json() as { detail?: string };
          if (body.detail) detail = body.detail;
        } catch { /* Keep the status-based error message. */ }
        throw new Error(detail);
      }

      setSongs((existingSongs) => existingSongs.filter((existingSong) => existingSong.id !== song.id));
      waveformCache.delete(song.id);
      if (currentSongRef.current?.id === song.id) {
        const audio = audioRef.current;
        if (audio) {
          audio.pause();
          audio.removeAttribute("src");
          audio.load();
        }
        setCurrentSong(null);
        setIsPlaying(false);
        setIsAudioLoading(false);
        setPlaybackError("");
        setCurrentTime(0);
        setDuration(null);
        loopStartRef.current = null;
        loopEndRef.current = null;
        setLoopStart(null);
        setLoopEnd(null);
        setLoopError("");
        waveformBufferStartRef.current = 0;
        waveformBufferUpdatePendingRef.current = false;
        waveformViewportStartRef.current = 0;
        setWaveformBufferStart(0);
        setWaveform(null);
        setWaveformLoading(false);
        setWaveformError("");
      }
    } catch (error) {
      setDeleteError(
        error instanceof TypeError
          ? `Could not connect to the backend while deleting “${song.original_filename}”. Check that it is running and try again.`
          : error instanceof Error ? error.message : `Could not delete “${song.original_filename}”.`,
      );
    } finally {
      deletingSongIdsRef.current.delete(song.id);
      setDeletingSongIds(new Set(deletingSongIdsRef.current));
    }
  }

  useEffect(() => {
    fetch(`${API_BASE_URL}/health`)
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
    request.open("POST", `${API_BASE_URL}/songs/upload`);
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


  const loopHighlightActive = duration !== null && duration > 0 && loopStart !== null && loopEnd !== null;
  const trackDuration = duration ?? waveform?.duration_seconds ?? 0;
  const visibleViewportStart = getWaveformViewportStart(currentTime, trackDuration);
  const visibleViewportEnd = Math.min(trackDuration, visibleViewportStart + WAVEFORM_WINDOW_SECONDS);
  const waveformPath = useMemo(() => {
    if (!waveform || waveform.peaks.length === 0) return "";
    const trackDuration = duration ?? waveform.duration_seconds;
    if (trackDuration <= 0) return "";

    const bufferEnd = Math.min(trackDuration, waveformBufferStart + WAVEFORM_BUFFER_SECONDS);
    const firstPeakIndex = Math.max(0, Math.floor((waveformBufferStart / trackDuration) * waveform.peaks.length));
    const afterLastPeakIndex = Math.min(
      waveform.peaks.length,
      Math.ceil((bufferEnd / trackDuration) * waveform.peaks.length),
    );
    const bufferedPeakCount = afterLastPeakIndex - firstPeakIndex;
    if (bufferedPeakCount <= 0) return "";
    const displayColumns = Math.min(
      bufferedPeakCount,
      Math.max(1, Math.floor((waveformDisplayWidth || 1000) / WAVEFORM_BAR_SPACING_PX)),
    );
    const pathParts: string[] = [];

    for (let column = 0; column < displayColumns; column += 1) {
      const firstPeak = firstPeakIndex + Math.floor((column * bufferedPeakCount) / displayColumns);
      const afterLastPeak = firstPeakIndex + Math.floor(((column + 1) * bufferedPeakCount) / displayColumns);
      let columnPeak = 0;
      for (let peakIndex = firstPeak; peakIndex < afterLastPeak; peakIndex += 1) {
        columnPeak = Math.max(columnPeak, waveform.peaks[peakIndex]);
      }

      const centerTime = ((firstPeak + afterLastPeak) / 2 / waveform.peaks.length) * trackDuration;
      const x = (centerTime - waveformBufferStart) * WAVEFORM_UNITS_PER_SECOND;
      const amplitude = Math.min(255, Math.max(0, columnPeak)) / 255;
      const halfHeight = amplitude * 42;
      pathParts.push(`M${x.toFixed(2)} ${(50 - halfHeight).toFixed(2)}V${(50 + halfHeight).toFixed(2)}`);
    }

    return pathParts.join("");
  }, [duration, waveform, waveformBufferStart, waveformDisplayWidth]);

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
          {deleteError && <p className="library-error" role="alert">{deleteError}</p>}
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
                    <div className="song-actions">
                      <button
                        className="song-play-button"
                        data-playback-shortcut
                        type="button"
                        onClick={() => handleSongButtonClick(song)}
                      >
                        {currentSong?.id === song.id && isPlaying ? "Pause" : "Play"}
                      </button>
                      <button
                        className="song-delete-button"
                        type="button"
                        aria-label={`Delete ${song.original_filename}`}
                        title="Delete song"
                        disabled={deletingSongIds.has(song.id)}
                        onClick={() => void handleDeleteSong(song)}
                      >
                        <span aria-hidden="true">🗑️</span>
                        {deletingSongIds.has(song.id) ? "Deleting…" : "Delete"}
                      </button>
                    </div>
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
            <button className="player-control" data-playback-shortcut type="button" onClick={togglePlayback} disabled={!currentSong}>
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
          <div className="loop-controls" aria-label="A–B loop controls">
            <button className="loop-control" data-playback-shortcut type="button" onClick={handleSetLoopStart} disabled={!currentSong}>
              Set A
            </button>
            <button className="loop-control" data-playback-shortcut type="button" onClick={handleSetLoopEnd} disabled={!currentSong}>
              Set B
            </button>
            <button
              className="loop-control loop-clear"
              data-playback-shortcut
              type="button"
              onClick={handleClearLoop}
              disabled={!currentSong || (loopStart === null && loopEnd === null)}
            >
              Clear loop
            </button>
            <span className="loop-points">
              A: {loopStart === null ? "--:--" : formatTime(loopStart)}
              <span aria-hidden="true"> · </span>
              B: {loopEnd === null ? "--:--" : formatTime(loopEnd)}
            </span>
          </div>
          {loopError && <p className="playback-error" role="alert">{loopError}</p>}
          <div className="playback-progress">
            {waveformLoading && <p className="waveform-message" role="status">Loading waveform…</p>}
            {waveformError && <p className="waveform-error" role="status">{waveformError}</p>}
            <div className={`waveform ${!waveform ? "waveform-empty" : ""}`}>
              {waveform ? (
                <svg
                  ref={waveformSvgRef}
                  className="waveform-svg"
                  viewBox="0 0 1000 100"
                  preserveAspectRatio="none"
                  role="slider"
                  aria-label="Seek through song waveform"
                  aria-valuemin={0}
                  aria-valuemax={duration ?? waveform.duration_seconds}
                  aria-valuenow={currentTime}
                  tabIndex={duration === null ? -1 : 0}
                  onClick={handleWaveformClick}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                      const audio = audioRef.current;
                      if (!audio || duration === null) return;
                      const step = event.shiftKey ? 0.1 : 1;
                      const direction = event.key === "ArrowLeft" ? -1 : 1;
                      let minimum = 0;
                      let maximum = duration;
                      if (loopStart !== null && loopEnd !== null) {
                        minimum = loopStart;
                        maximum = loopEnd;
                      }
                      const nextTime = Math.min(maximum, Math.max(minimum, audio.currentTime + direction * step));
                      audio.currentTime = nextTime;
                      setCurrentTime(nextTime);
                      updateWaveformPosition(nextTime, duration);
                      setShowTimeTenths(event.shiftKey);
                      event.preventDefault();
                    }
                  }}
                >
                  <defs>
                    <clipPath id="waveform-played-clip"><rect ref={waveformClipRef} x="0" y="0" width="0" height="100" /></clipPath>
                  </defs>
                  <g ref={waveformGroupRef}>
                    <path className="waveform-peaks" d={waveformPath} />
                    {loopHighlightActive && loopStart !== null && loopEnd !== null && (
                      <rect
                        className="waveform-loop-range"
                        x={(loopStart - waveformBufferStart) * WAVEFORM_UNITS_PER_SECOND}
                        y="0"
                        width={(loopEnd - loopStart) * WAVEFORM_UNITS_PER_SECOND}
                        height="100"
                      />
                    )}
                    <path className="waveform-peaks waveform-peaks-played" d={waveformPath} clipPath="url(#waveform-played-clip)" />
                    {loopStart !== null && duration !== null && (
                      <line
                        className="waveform-marker waveform-marker-a"
                        x1={(loopStart - waveformBufferStart) * WAVEFORM_UNITS_PER_SECOND}
                        x2={(loopStart - waveformBufferStart) * WAVEFORM_UNITS_PER_SECOND}
                        y1="0"
                        y2="100"
                      />
                    )}
                    {loopEnd !== null && duration !== null && (
                      <line
                        className="waveform-marker waveform-marker-b"
                        x1={(loopEnd - waveformBufferStart) * WAVEFORM_UNITS_PER_SECOND}
                        x2={(loopEnd - waveformBufferStart) * WAVEFORM_UNITS_PER_SECOND}
                        y1="0"
                        y2="100"
                      />
                    )}
                  </g>
                  <line ref={waveformCursorRef} className="waveform-cursor" x1="0" x2="0" y1="0" y2="100" />
                </svg>
              ) : (
                <div className="waveform-placeholder" aria-hidden="true">{currentSong ? "Waveform unavailable" : "Select a song to view its waveform"}</div>
              )}
            </div>
            <div className="playback-times" aria-live="off">
              <span className="playback-time-start">{trackDuration > 0 ? formatTime(visibleViewportStart) : "--:--"}</span>
              <span className="playback-time-now">Now {formatTime(currentTime, showTimeTenths)}</span>
              <span className="playback-time-end">{trackDuration > 0 ? formatTime(visibleViewportEnd) : "--:--"}</span>
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

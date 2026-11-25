"""Generate compact, versioned amplitude peaks from an audio file with FFmpeg."""

from __future__ import annotations

import array
import json
import math
import os
import selectors
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable

WAVEFORM_VERSION = 1
DEFAULT_MAX_PEAKS = 2500
MAX_ALLOWED_PEAKS = 3000
PEAKS_PER_SECOND = 50
MAX_CHANNELS = 32
PCM_CHUNK_BYTES = 64 * 1024
DEFAULT_PROBE_TIMEOUT_SECONDS = 10.0
DEFAULT_DECODE_TIMEOUT_SECONDS = 180.0


class WaveformGenerationError(RuntimeError):
    """Base error raised when a waveform cannot be generated."""


class FFmpegUnavailableError(WaveformGenerationError):
    """Raised when FFmpeg or FFprobe is not available on PATH."""


class InvalidAudioError(WaveformGenerationError):
    """Raised when the input is not a supported, decodable audio file."""


class AudioProcessingTimeoutError(WaveformGenerationError):
    """Raised when FFprobe or FFmpeg exceeds its configured time limit."""


def _positive_timeout(name: str, value: float) -> float:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or value <= 0
    ):
        raise ValueError(f"{name} must be a finite number greater than zero.")
    return float(value)


def _probe_audio(
    audio_path: Path,
    ffprobe_path: str,
    timeout_seconds: float,
) -> tuple[int, int]:
    command = [
        ffprobe_path,
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=codec_type,sample_rate,channels,duration:format=duration",
        "-of",
        "json",
        str(audio_path),
    ]

    try:
        result = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            check=False,
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired as error:
        raise AudioProcessingTimeoutError("FFprobe timed out while inspecting the audio file.") from error
    except OSError as error:
        raise WaveformGenerationError("Could not start FFprobe.") from error

    if result.returncode != 0:
        raise InvalidAudioError("FFprobe could not read the audio file.")

    try:
        probe_data = json.loads(result.stdout)
        streams = probe_data.get("streams", [])
        stream = streams[0] if streams else None
        if not isinstance(stream, dict) or stream.get("codec_type") != "audio":
            raise ValueError("No audio stream was found.")

        sample_rate = int(stream["sample_rate"])
        channels = int(stream["channels"])
        try:
            stream_duration = float(stream.get("duration", "nan"))
        except (TypeError, ValueError):
            stream_duration = float("nan")
        try:
            format_duration = float(probe_data.get("format", {}).get("duration", "nan"))
        except (TypeError, ValueError, AttributeError):
            format_duration = float("nan")
        duration_seconds = stream_duration if math.isfinite(stream_duration) and stream_duration > 0 else format_duration
    except (KeyError, IndexError, TypeError, ValueError, json.JSONDecodeError, AttributeError) as error:
        raise InvalidAudioError("The audio file has incomplete or invalid stream information.") from error

    if not math.isfinite(duration_seconds) or duration_seconds <= 0:
        raise InvalidAudioError("The audio file has no usable duration.")
    if sample_rate <= 0 or channels <= 0 or channels > MAX_CHANNELS:
        raise InvalidAudioError("The audio file has unsupported sample-rate or channel information.")

    return sample_rate, channels


def _stop_process(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is None:
        try:
            process.kill()
        except ProcessLookupError:
            # The child may exit between poll() and kill(). Still wait below
            # so that its process handle is reaped.
            pass
    try:
        process.wait()
    except OSError:
        pass


def _stream_pcm(
    audio_path: Path,
    ffmpeg_path: str,
    sample_rate: int,
    channels: int,
    timeout_seconds: float,
    on_pcm_chunk: Callable[[bytes], None] | None = None,
) -> int:
    """Stream FFmpeg's PCM output to a callback and return its frame count."""
    frame_bytes = channels * 2  # signed 16-bit PCM, interleaved by channel
    frame_count = 0
    pending_bytes = b""

    command = [
        ffmpeg_path,
        "-nostdin",
        "-v",
        "error",
        "-i",
        str(audio_path),
        "-map",
        "0:a:0",
        "-vn",
        "-sn",
        "-dn",
        "-ac",
        str(channels),
        "-ar",
        str(sample_rate),
        "-c:a",
        "pcm_s16le",
        "-f",
        "s16le",
        "pipe:1",
    ]

    try:
        process = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            bufsize=0,
        )
    except OSError as error:
        raise WaveformGenerationError("Could not start FFmpeg.") from error

    deadline = time.monotonic() + timeout_seconds
    try:
        if process.stdout is None:
            raise WaveformGenerationError("FFmpeg did not provide a PCM output stream.")

        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while selector.get_map():
                remaining_seconds = deadline - time.monotonic()
                if remaining_seconds <= 0:
                    raise AudioProcessingTimeoutError("FFmpeg timed out while decoding the audio file.")

                ready = selector.select(min(remaining_seconds, 1.0))
                if not ready:
                    continue

                for key, _ in ready:
                    chunk = os.read(key.fd, PCM_CHUNK_BYTES)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue

                    raw_pcm = pending_bytes + chunk
                    complete_length = len(raw_pcm) - (len(raw_pcm) % frame_bytes)
                    pending_bytes = raw_pcm[complete_length:]
                    if complete_length == 0:
                        continue

                    frame_count += complete_length // frame_bytes
                    if on_pcm_chunk is not None:
                        on_pcm_chunk(raw_pcm[:complete_length])

        remaining_seconds = deadline - time.monotonic()
        if remaining_seconds <= 0:
            raise AudioProcessingTimeoutError("FFmpeg timed out while decoding the audio file.")
        try:
            return_code = process.wait(timeout=remaining_seconds)
        except subprocess.TimeoutExpired as error:
            raise AudioProcessingTimeoutError("FFmpeg timed out while decoding the audio file.") from error

        if return_code != 0:
            raise InvalidAudioError("FFmpeg could not decode the audio file.")
        if pending_bytes:
            raise InvalidAudioError("FFmpeg returned incomplete PCM audio data.")
        if frame_count == 0:
            raise InvalidAudioError("The audio file contains no decodable samples.")

        return frame_count
    except BaseException:
        _stop_process(process)
        raise
    finally:
        if process.stdout is not None:
            process.stdout.close()


def _decode_peaks(
    audio_path: Path,
    ffmpeg_path: str,
    sample_rate: int,
    channels: int,
    frame_count: int,
    max_peaks: int,
    timeout_seconds: float,
) -> list[int]:
    duration_seconds = frame_count / sample_rate
    peak_count = min(
        max_peaks,
        max(1, math.ceil(duration_seconds * PEAKS_PER_SECOND)),
        frame_count,
    )
    peaks = [0] * peak_count
    frame_index = 0
    bucket_index = 0
    bucket_end = (frame_count * (bucket_index + 1)) // peak_count
    bucket_peak = 0

    def aggregate_pcm_chunk(pcm_chunk: bytes) -> None:
        nonlocal frame_index, bucket_index, bucket_end, bucket_peak

        samples = array.array("h")
        samples.frombytes(pcm_chunk)
        if sys.byteorder != "little":
            samples.byteswap()

        block_frame = 0
        block_frames = len(samples) // channels
        while block_frame < block_frames:
            if frame_index >= frame_count:
                raise WaveformGenerationError("The audio changed while its waveform was being generated.")
            while bucket_index < peak_count - 1 and frame_index >= bucket_end:
                peaks[bucket_index] = min(255, round((bucket_peak / 32768) * 255))
                bucket_index += 1
                bucket_peak = 0
                bucket_end = (frame_count * (bucket_index + 1)) // peak_count

            frames_in_bucket = min(block_frames - block_frame, bucket_end - frame_index)
            first_sample = block_frame * channels
            last_sample = (block_frame + frames_in_bucket) * channels
            sample_view = memoryview(samples)[first_sample:last_sample]
            bucket_peak = max(bucket_peak, abs(min(sample_view)), abs(max(sample_view)))

            block_frame += frames_in_bucket
            frame_index += frames_in_bucket

    decoded_frames = _stream_pcm(
        audio_path,
        ffmpeg_path,
        sample_rate,
        channels,
        timeout_seconds,
        aggregate_pcm_chunk,
    )
    if decoded_frames != frame_count or frame_index != frame_count:
        raise WaveformGenerationError("The audio changed while its waveform was being generated.")

    peaks[bucket_index] = min(255, round((bucket_peak / 32768) * 255))
    return peaks


def generate_waveform(
    audio_path: str | Path,
    *,
    max_peaks: int = DEFAULT_MAX_PEAKS,
    probe_timeout_seconds: float = DEFAULT_PROBE_TIMEOUT_SECONDS,
    decode_timeout_seconds: float = DEFAULT_DECODE_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    """Return mono-envelope peaks quantized to integers in the inclusive 0–255 range.

    The peak count targets 50 buckets per second, capped by ``max_peaks``. Each
    bucket stores the largest absolute 16-bit PCM sample across all channels.
    PCM is read incrementally, so memory use is proportional to the peak limit
    and the fixed-size decode buffer, not the decoded audio duration.
    """
    if isinstance(max_peaks, bool) or not isinstance(max_peaks, int) or not 1 <= max_peaks <= MAX_ALLOWED_PEAKS:
        raise ValueError(f"max_peaks must be an integer between 1 and {MAX_ALLOWED_PEAKS}.")
    probe_timeout_seconds = _positive_timeout("probe_timeout_seconds", probe_timeout_seconds)
    decode_timeout_seconds = _positive_timeout("decode_timeout_seconds", decode_timeout_seconds)

    ffmpeg_path = shutil.which("ffmpeg")
    ffprobe_path = shutil.which("ffprobe")
    if ffmpeg_path is None or ffprobe_path is None:
        missing_tools = [
            tool_name
            for tool_name, tool_path in (("FFmpeg", ffmpeg_path), ("FFprobe", ffprobe_path))
            if tool_path is None
        ]
        raise FFmpegUnavailableError(f"Could not find {' and '.join(missing_tools)} on PATH.")

    try:
        source_path = Path(audio_path).expanduser().resolve(strict=True)
    except (OSError, RuntimeError, TypeError, ValueError) as error:
        raise InvalidAudioError("The audio file does not exist or cannot be accessed.") from error
    if not source_path.is_file():
        raise InvalidAudioError("The audio path must refer to a file.")

    sample_rate, channels = _probe_audio(
        source_path,
        ffprobe_path,
        probe_timeout_seconds,
    )

    # FFprobe duration can include encoder padding or disagree with the number
    # of samples FFmpeg actually decodes. Count frames first so peak buckets
    # can be partitioned over the exact PCM frame count on the second pass.
    decode_deadline = time.monotonic() + decode_timeout_seconds
    frame_count = _stream_pcm(
        source_path,
        ffmpeg_path,
        sample_rate,
        channels,
        decode_deadline - time.monotonic(),
    )
    remaining_decode_time = decode_deadline - time.monotonic()
    if remaining_decode_time <= 0:
        raise AudioProcessingTimeoutError("FFmpeg timed out while generating the audio waveform.")
    peaks = _decode_peaks(
        source_path,
        ffmpeg_path,
        sample_rate,
        channels,
        frame_count,
        max_peaks,
        remaining_decode_time,
    )

    return {
        "version": WAVEFORM_VERSION,
        "duration_seconds": frame_count / sample_rate,
        "peaks": peaks,
    }

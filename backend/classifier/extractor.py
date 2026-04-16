"""
Audio Feature Extractor for the Classifier Module.
Uses pydub + numpy (available via the openai-whisper dependency).
All processing happens in daemon background threads — never blocks the main job.

Whisper transcription is disabled by default (CPU-intensive).
Enable with env var: CLASSIFIER_WHISPER=true
"""
import os
import threading
import tempfile
from pathlib import Path
from typing import Optional, Callable

try:
    import numpy as np
    NUMPY_AVAILABLE = True
except ImportError:
    NUMPY_AVAILABLE = False

try:
    from pydub import AudioSegment
    from pydub.silence import detect_silence
    PYDUB_AVAILABLE = True
except ImportError:
    PYDUB_AVAILABLE = False

try:
    import whisper as _whisper_lib
    WHISPER_AVAILABLE = True
except ImportError:
    WHISPER_AVAILABLE = False

# Enable Whisper transcription for classifier (disabled by default — CPU-intensive)
CLASSIFIER_WHISPER = os.getenv("CLASSIFIER_WHISPER", "false").lower() == "true"

_whisper_model      = None
_whisper_model_lock = threading.Lock()

# ── Feature cache ─────────────────────────────────────────────────────────────
# Keyed by f"{job_id}_{section}_{index}" → features dict
_feature_cache      : dict[str, dict] = {}
_feature_cache_lock = threading.Lock()


def get_cached_features(job_id: str, section: str, index: int) -> Optional[dict]:
    key = f"{job_id}_{section}_{index}"
    with _feature_cache_lock:
        return _feature_cache.get(key)


def set_cached_features(job_id: str, section: str, index: int, features: dict):
    key = f"{job_id}_{section}_{index}"
    with _feature_cache_lock:
        _feature_cache[key] = features


def clear_job_cache(job_id: str):
    """Remove all cached features for a job (call when job is cancelled/done)."""
    prefix = f"{job_id}_"
    with _feature_cache_lock:
        for k in [k for k in _feature_cache if k.startswith(prefix)]:
            del _feature_cache[k]


# ── Whisper model (lazy, "base") ──────────────────────────────────────────────

def _get_classifier_whisper_model():
    global _whisper_model
    if _whisper_model is None:
        with _whisper_model_lock:
            if _whisper_model is None:
                _whisper_model = _whisper_lib.load_model("base")
    return _whisper_model


# ── Feature extraction ────────────────────────────────────────────────────────

def extraer_features_audio(audio_seg: "AudioSegment", texto_original: str) -> dict:
    """
    Extract acoustic features from a pydub AudioSegment.
    Returns a dict with all features defined in the spec.
    On any failure returns safe defaults.
    """
    defaults = {
        "duracion_seg": 0.0,
        "tempo_bpm": 0.0,
        "energia_promedio": 0.0,
        "variacion_pitch": 0.0,
        "num_silencios": 0,
        "duracion_promedio_silencio_seg": 0.0,
        "energia_max": 0.0,
        "energia_min": 0.0,
        "texto_original": texto_original,
        "texto_transcrito": None,
        "coincidencia_texto": None,
    }

    if not PYDUB_AVAILABLE or not NUMPY_AVAILABLE:
        return defaults

    try:
        audio_mono = audio_seg.set_channels(1)
        duracion_seg = len(audio_mono) / 1000.0

        if duracion_seg < 0.2:
            defaults["duracion_seg"] = duracion_seg
            return defaults

        samples = np.array(audio_mono.get_array_of_samples(), dtype=np.float32)
        sr      = audio_mono.frame_rate

        if len(samples) == 0:
            defaults["duracion_seg"] = duracion_seg
            return defaults

        # ── Energy ───────────────────────────────────────────────
        max_val      = float(2 ** (audio_mono.sample_width * 8 - 1))
        s_norm       = samples / max_val
        energia_prom = float(np.sqrt(np.mean(s_norm ** 2) + 1e-12))
        energia_max  = float(np.max(np.abs(s_norm)))
        energia_min  = float(np.min(np.abs(s_norm)))

        # ── Silencios ─────────────────────────────────────────────
        thresh_db = audio_mono.dBFS - 14
        silencios = detect_silence(audio_mono, min_silence_len=100, silence_thresh=thresh_db)
        num_sil   = len(silencios)
        durs_sil  = [(e - s) / 1000.0 for s, e in silencios]
        dur_prom_sil = (sum(durs_sil) / len(durs_sil)) if durs_sil else 0.0

        # ── Tempo BPM (syllabic rate) ─────────────────────────────
        tempo_bpm = _estimate_tempo_bpm(s_norm, sr)

        # ── Pitch variation (ZCR std dev) ─────────────────────────
        variacion_pitch = _estimate_pitch_variation(s_norm, sr)

        features = {
            "duracion_seg":              round(duracion_seg,    3),
            "tempo_bpm":                 round(tempo_bpm,       1),
            "energia_promedio":          round(energia_prom,    6),
            "variacion_pitch":           round(variacion_pitch, 3),
            "num_silencios":             num_sil,
            "duracion_promedio_silencio_seg": round(dur_prom_sil, 3),
            "energia_max":               round(energia_max,     5),
            "energia_min":               round(energia_min,     8),
            "texto_original":            texto_original,
            "texto_transcrito":          None,
            "coincidencia_texto":        None,
        }

        # ── Transcripción (opcional, carga CPU) ───────────────────
        if CLASSIFIER_WHISPER and WHISPER_AVAILABLE:
            try:
                texto_t, coincid = _transcribir_audio(audio_mono, texto_original)
                features["texto_transcrito"]   = texto_t
                features["coincidencia_texto"] = coincid
            except Exception:
                pass

        return features

    except Exception as exc:
        print(f"[classifier.extractor] extraer_features_audio error: {exc}")
        defaults["duracion_seg"] = len(audio_seg) / 1000.0 if audio_seg else 0.0
        return defaults


def _estimate_tempo_bpm(samples: "np.ndarray", sample_rate: int) -> float:
    """Estimate speech syllabic rate as BPM using energy-envelope peak detection."""
    frame_size = max(1, int(sample_rate * 0.008))
    n_frames   = len(samples) // frame_size
    if n_frames < 20:
        return 0.0

    energy = np.array([
        float(np.sqrt(np.mean(samples[i * frame_size:(i + 1) * frame_size] ** 2) + 1e-12))
        for i in range(n_frames)
    ])

    window   = min(10, n_frames // 4)
    smoothed = np.convolve(energy, np.ones(window) / window, mode="same")

    threshold = np.mean(smoothed) * 0.5
    peaks = [
        i for i in range(1, len(smoothed) - 1)
        if smoothed[i] > smoothed[i - 1]
        and smoothed[i] > smoothed[i + 1]
        and smoothed[i] > threshold
    ]

    if len(peaks) < 4:
        return 0.0

    intervals = [
        (peaks[k + 1] - peaks[k]) * frame_size / sample_rate
        for k in range(len(peaks) - 1)
    ]
    valid = [iv for iv in intervals if 0.05 < iv < 0.5]
    if len(valid) < 3:
        return 0.0

    med = float(np.median(valid))
    return min(round(60.0 / med, 1), 300.0) if med > 0 else 0.0


def _estimate_pitch_variation(samples: "np.ndarray", sample_rate: int) -> float:
    """Estimate pitch variation via Zero-Crossing Rate std dev across frames."""
    frame_size = max(1, int(sample_rate * 0.025))
    hop_size   = max(1, int(sample_rate * 0.010))

    zcrs = []
    for i in range(0, len(samples) - frame_size, hop_size):
        frame = samples[i:i + frame_size]
        zcr   = float(np.sum(np.abs(np.diff(np.sign(frame)))) / (2 * frame_size))
        zcrs.append(zcr)

    if len(zcrs) < 5:
        return 0.0

    return round(float(np.std(zcrs)) * 1000, 3)


def _token_overlap(a: str, b: str) -> float:
    """Simple token-overlap similarity (Jaccard) in percent."""
    if not a or not b:
        return 0.0
    wa, wb = set(a.lower().split()), set(b.lower().split())
    if not wa and not wb:
        return 100.0
    union = wa | wb
    return round(len(wa & wb) / len(union) * 100, 1) if union else 0.0


def _transcribir_audio(audio_mono: "AudioSegment", texto_original: str) -> tuple:
    """Transcribe with Whisper 'base' and compute similarity to original text."""
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            tmp_path = f.name
        audio_mono.export(tmp_path, format="wav")
        model   = _get_classifier_whisper_model()
        result  = model.transcribe(tmp_path, language=None, verbose=False, fp16=False)
        texto_t = result.get("text", "").strip()
        return texto_t, _token_overlap(texto_original, texto_t)
    except Exception:
        return None, None
    finally:
        if tmp_path:
            Path(tmp_path).unlink(missing_ok=True)


# ── Background cache task ─────────────────────────────────────────────────────

def cachear_features_async(
    job_id: str,
    section: str,
    index: int,
    ruta_preview: str,
    texto: str,
    params_elevenlabs: dict,
    on_done: Optional[Callable[[dict], None]] = None,
):
    """
    Load the preview WAV, extract features, cache them.
    Designed to run inside a daemon threading.Thread.
    Calls on_done(features) when complete (optional, used to emit SSE events).
    """
    if not PYDUB_AVAILABLE:
        return
    try:
        path = Path(ruta_preview)
        if not path.exists():
            return
        audio    = AudioSegment.from_file(str(path))
        features = extraer_features_audio(audio, texto)
        features["params_elevenlabs"] = params_elevenlabs
        set_cached_features(job_id, section, index, features)
        if on_done:
            on_done(features)
    except Exception as exc:
        print(f"[classifier.extractor] cachear_features_async error: {exc}")

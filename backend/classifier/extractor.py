"""
Audio Feature Extractor for the Classifier Module.
Integrates WhisperX (WPM + transcription), Librosa (jitter, shimmer, spectral_centroid),
and NISQA (acoustic quality score). Falls back gracefully when libraries unavailable.
All processing happens in daemon background threads — never blocks the main job.

Env vars:
  CLASSIFIER_WHISPERX=true  — enable WhisperX transcription + WPM (CPU-intensive)
  CLASSIFIER_NISQA=true     — enable NISQA MOS score (requires nisqa package)
"""
import os
import threading
import tempfile
from pathlib import Path
from typing import Optional, Callable
import string
import logging
import traceback

# Configurar el logger para que Uvicorn/Docker no lo silencien
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)


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
    import whisperx
    WHISPERX_AVAILABLE = True
    logger.info("✅ WhisperX importado correctamente al iniciar el servidor.")
except Exception as e:
    WHISPERX_AVAILABLE = False
    logger.error(f"❌ ERROR CRÍTICO IMPORTANDO WHISPERX EN EL ARRANQUE: {e}")
    logger.error(traceback.format_exc())

try:
    import librosa as _librosa_lib
    LIBROSA_AVAILABLE = True
except ImportError:
    LIBROSA_AVAILABLE = False

# NISQA — try multiple import paths used by different package versions
NISQA_AVAILABLE = False
_nisqa_predict_fn = None
try:
    from nisqa.predict import predict_file as _nisqa_predict_fn  # type: ignore
    NISQA_AVAILABLE = True
except (ImportError, Exception):
    try:
        from nisqa.predict import predict_mos as _nisqa_predict_fn  # type: ignore
        NISQA_AVAILABLE = True
    except (ImportError, Exception):
        pass

CLASSIFIER_WHISPERX = os.getenv("CLASSIFIER_WHISPERX", "false").lower() == "true"
CLASSIFIER_NISQA    = os.getenv("CLASSIFIER_NISQA",    "false").lower() == "true"

_whisperx_model      = None
_whisperx_model_lock = threading.Lock()

# ── Feature cache ─────────────────────────────────────────────────────────────
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


# ── WhisperX model (lazy, loaded on first use) ────────────────────────────────

def _get_whisperx_model():
    global _whisperx_model
    if _whisperx_model is None:
        with _whisperx_model_lock:
            if _whisperx_model is None:
                logger.info("⏳ Iniciando la carga del modelo WhisperX 'base' en memoria...")
                try:
                    _whisperx_model = whisperx.load_model(
                        "base", device="cpu", compute_type="float32"
                    )
                    logger.info("✅ Modelo WhisperX cargado exitosamente.")
                except Exception as e:
                    logger.error(f"❌ ERROR CARGANDO LOS PESOS DE WHISPERX: {e}")
                    logger.error(traceback.format_exc())
                    raise e
    return _whisperx_model


# ── Feature extraction ────────────────────────────────────────────────────────

def extraer_features_audio(audio_seg: "AudioSegment", texto_original: str) -> dict:
    """
    Extract acoustic features from a pydub AudioSegment.
    Returns a dict with all features. On any failure returns safe defaults.
    """
    defaults = {
        "duracion_seg":                   0.0,
        "wpm":                            0.0,
        "densidad_silencios":             0.0,
        "duracion_promedio_silencio_seg": 0.0,
        "energia_promedio":               0.0,
        "variacion_pitch":                0.0,
        "jitter":                         None,
        "shimmer":                        None,
        "spectral_centroid":              None,
        "nisqa_score":                    None,
        "energia_max":                    0.0,
        "energia_min":                    0.0,
        "texto_original":                 texto_original,
        "texto_transcrito":               None,
        "coincidencia_texto":             None,
        "descartar_automatico":           False,
        "razon_descarte":                 None,
    }

    if not PYDUB_AVAILABLE or not NUMPY_AVAILABLE:
        return defaults

    try:
        audio_mono   = audio_seg.set_channels(1)
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

        # ── Silencios → densidad (total_sil_secs / duracion) ─────
        thresh_db = audio_mono.dBFS - 14
        silencios = detect_silence(audio_mono, min_silence_len=100, silence_thresh=thresh_db)
        durs_sil  = [(e - s) / 1000.0 for s, e in silencios]
        total_sil_secs     = sum(durs_sil)
        densidad_silencios = round(total_sil_secs / duracion_seg, 4) if duracion_seg > 0 else 0.0
        dur_prom_sil       = round(total_sil_secs / len(durs_sil), 3) if durs_sil else 0.0

        # ── Pitch variation (ZCR std dev) ─────────────────────────
        variacion_pitch = _estimate_pitch_variation(s_norm, sr)

        features = {
            "duracion_seg":                   round(duracion_seg, 3),
            "wpm":                            0.0,
            "densidad_silencios":             densidad_silencios,
            "duracion_promedio_silencio_seg": dur_prom_sil,
            "energia_promedio":               round(energia_prom, 6),
            "variacion_pitch":                round(variacion_pitch, 3),
            "jitter":                         None,
            "shimmer":                        None,
            "spectral_centroid":              None,
            "nisqa_score":                    None,
            "energia_max":                    round(energia_max, 5),
            "energia_min":                    round(energia_min, 8),
            "texto_original":                 texto_original,
            "texto_transcrito":               None,
            "coincidencia_texto":             None,
            "descartar_automatico":           False,
            "razon_descarte":                 None,
        }

        # ── Librosa micro-vocal analysis ──────────────────────────
        if LIBROSA_AVAILABLE:
            try:
                y_f32 = s_norm.astype(np.float32)
                features["jitter"]            = _compute_jitter(y_f32, sr)
                features["shimmer"]           = _compute_shimmer(y_f32, sr)
                features["spectral_centroid"] = _compute_spectral_centroid(y_f32, sr)
            except Exception as exc:
                print(f"[classifier.extractor] librosa error: {exc}")

        # ── WhisperX: WPM + transcription + text match ────────────
        if CLASSIFIER_WHISPERX and WHISPERX_AVAILABLE:
            try:
                texto_t, coincid, wpm = _transcribir_whisperx(
                    audio_mono, texto_original, duracion_seg
                )
                features["texto_transcrito"]   = texto_t
                features["coincidencia_texto"] = coincid
                features["wpm"]                = wpm
                # Early discard: < 95% text match → auto-reject
                if coincid is not None and coincid < 95.0:
                    features["descartar_automatico"] = True
                    features["razon_descarte"]       = "mala_pronunciacion"
            except Exception as exc:
                print(f"[classifier.extractor] whisperx error: {exc}")

        # ── NISQA acoustic quality score (1.0 – 5.0) ─────────────
        if CLASSIFIER_NISQA and NISQA_AVAILABLE:
            try:
                features["nisqa_score"] = _compute_nisqa(audio_mono)
            except Exception as exc:
                print(f"[classifier.extractor] nisqa error: {exc}")

        return features

    except Exception as exc:
        print(f"[classifier.extractor] extraer_features_audio error: {exc}")
        defaults["duracion_seg"] = len(audio_seg) / 1000.0 if audio_seg else 0.0
        return defaults


# ── Librosa helpers ───────────────────────────────────────────────────────────

def _compute_jitter(y: "np.ndarray", sr: int) -> Optional[float]:
    """Jitter: period-to-period variation of the fundamental frequency."""
    f0, _, _ = _librosa_lib.pyin(
        y,
        fmin=_librosa_lib.note_to_hz("C2"),
        fmax=_librosa_lib.note_to_hz("C7"),
        sr=sr,
        fill_na=None,
    )
    if f0 is None:
        return None
    f0_voiced = f0[~np.isnan(f0)]
    if len(f0_voiced) < 4:
        return None
    periods = 1.0 / f0_voiced
    jitter  = float(np.mean(np.abs(np.diff(periods))) / (np.mean(periods) + 1e-12))
    return round(jitter, 6)


def _compute_shimmer(y: "np.ndarray", sr: int) -> Optional[float]:
    """Shimmer: amplitude variation between consecutive analysis frames."""
    rms = _librosa_lib.feature.rms(y=y, frame_length=2048, hop_length=512)[0]
    if len(rms) < 4:
        return None
    shimmer = float(np.mean(np.abs(np.diff(rms))) / (np.mean(rms) + 1e-12))
    return round(shimmer, 6)


def _compute_spectral_centroid(y: "np.ndarray", sr: int) -> Optional[float]:
    """Spectral centroid: weighted mean frequency — high values indicate metallic AI artifacts."""
    sc = _librosa_lib.feature.spectral_centroid(y=y, sr=sr)
    return round(float(np.mean(sc)), 2)


# ── NISQA helper ──────────────────────────────────────────────────────────────

def _compute_nisqa(audio_mono: "AudioSegment") -> Optional[float]:
    """Run NISQA MOS prediction on a mono audio segment. Returns score 1.0–5.0."""
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            tmp_path = f.name
        audio_mono.export(tmp_path, format="wav")
        score = _nisqa_predict_fn(tmp_path)
        return round(float(score), 3)
    except Exception:
        return None
    finally:
        if tmp_path:
            Path(tmp_path).unlink(missing_ok=True)


# ── WhisperX transcription ────────────────────────────────────────────────────

def _transcribir_whisperx(
    audio_mono: "AudioSegment", texto_original: str, duracion_seg: float
) -> tuple:
    """Transcribe with WhisperX; return (texto_transcrito, coincidencia_pct, wpm)."""
    logger.info("🎙️ Entrando a la función de transcripción de WhisperX...")
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            tmp_path = f.name
        audio_mono.export(tmp_path, format="wav")
        logger.info(f"📁 Audio temporal guardado en: {tmp_path}")

        model    = _get_whisperx_model()
        logger.info("🧠 Pasando audio al modelo de transcripción...")
        
        result   = model.transcribe(tmp_path, batch_size=8)
        logger.info("✅ Transcripción completada. Extrayendo segmentos...")
        
        segments = result.get("segments", [])

        texto_t = " ".join(s.get("text", "") for s in segments).strip()
        words   = [w for s in segments for w in s.get("words", [])]
        n_words = len(words) if words else len(texto_t.split())
        wpm     = round((n_words / duracion_seg) * 60, 1) if duracion_seg > 0 else 0.0
        
        coincid = _token_overlap(texto_original, texto_t)
        
        logger.info(f"📊 Resultados - WPM: {wpm}, Coincidencia: {coincid}%")
        return texto_t, coincid, wpm
    except Exception as e:
        logger.error(f"❌ ERROR FATAL DURANTE LA TRANSCRIPCIÓN: {e}")
        logger.error(traceback.format_exc())
        return None, None, 0.0
    finally:
        if tmp_path:
            Path(tmp_path).unlink(missing_ok=True)

# ── Pitch variation (ZCR) ─────────────────────────────────────────────────────

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


# ── Text similarity ───────────────────────────────────────────────────────────

def _token_overlap(a: str, b: str) -> float:
    """Token-overlap (Jaccard) similarity in percent, ignoring punctuation."""
    if not a or not b:
        return 0.0
        
    # Eliminar signos de puntuación y pasar a minúsculas
    a_clean = a.translate(str.maketrans('', '', string.punctuation)).lower()
    b_clean = b.translate(str.maketrans('', '', string.punctuation)).lower()
    
    wa, wb = set(a_clean.split()), set(b_clean.split())
    
    if not wa and not wb:
        return 100.0
        
    union = wa | wb
    return round(len(wa & wb) / len(union) * 100, 1) if union else 0.0

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
    Calls on_done(features) when complete.
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

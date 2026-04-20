"""
AudioSync — Transcription endpoint
POST /api/audiosync/transcribe

Uses the locally installed openai-whisper model to extract sentence-level
timestamps from an audio file.  Model is loaded lazily on first request and
cached for subsequent calls.
"""
import os
import tempfile
import threading
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool

router = APIRouter(tags=["audiosync"])

# ── Model cache ────────────────────────────────────────────────────────────────

WHISPER_MODEL_NAME = os.getenv("AUDIOSYNC_WHISPER_MODEL", "base")

_model_cache: dict = {}
_model_lock = threading.Lock()


def _load_model():
    with _model_lock:
        if WHISPER_MODEL_NAME not in _model_cache:
            try:
                import whisper as _w            # openai-whisper
                _model_cache[WHISPER_MODEL_NAME] = _w.load_model(WHISPER_MODEL_NAME)
            except Exception as exc:
                raise RuntimeError(str(exc)) from exc
    return _model_cache[WHISPER_MODEL_NAME]


# ── Synchronous transcription (runs in thread-pool) ───────────────────────────

def _do_transcribe(audio_path: str, language: str | None) -> dict:
    model = _load_model()
    return model.transcribe(
        audio_path,
        language=language,
        word_timestamps=True,
        verbose=False,
        fp16=False,          # avoid GPU-only warnings on CPU boxes
    )


def _result_to_sentences(result: dict) -> list[dict]:
    """Convert Whisper segments to plain sentence dicts."""
    return [
        {
            "text":  seg["text"].strip(),
            "start": round(seg["start"], 3),
            "end":   round(seg["end"],   3),
        }
        for seg in result.get("segments", [])
        if seg.get("text", "").strip()
    ]


# ── Endpoint ───────────────────────────────────────────────────────────────────

@router.post("/api/audiosync/transcribe")
async def transcribe_audio(
    file: UploadFile = File(...),
    language: str    = Form("es"),
):
    """
    Transcribe an audio file and return sentence-level timestamps.

    Body (multipart):
      - file:     audio file (mp3, wav, m4a, ogg, flac, …)
      - language: ISO-639-1 code ("es", "en", …) or "auto" for auto-detect

    Returns:
      { text, sentences: [{text, start, end}], words: [{word, start, end}] }
    """
    try:
        import whisper  # noqa: F401 — presence check
    except ImportError:
        raise HTTPException(503, "Whisper no está disponible en este servidor")

    audio_bytes = await file.read()
    suffix      = Path(file.filename or "audio.mp3").suffix or ".mp3"
    tmp_path: str | None = None

    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(audio_bytes)
            tmp_path = tmp.name

        lang   = language if language not in ("auto", "") else None
        result = await run_in_threadpool(_do_transcribe, tmp_path, lang)

    except RuntimeError as exc:
        raise HTTPException(500, f"Error al cargar el modelo Whisper: {exc}") from exc
    except Exception as exc:
        raise HTTPException(500, f"Error al transcribir: {exc}") from exc
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    sentences = _result_to_sentences(result)
    words = [
        {
            "word":  w["word"],
            "start": round(w["start"], 3),
            "end":   round(w["end"],   3),
        }
        for seg in result.get("segments", [])
        for w in seg.get("words", [])
    ]

    return {
        "text":      result.get("text", "").strip(),
        "sentences": sentences,
        "words":     words,
    }

"""
AudioSync — Transcription endpoint (async job queue)

POST /api/audiosync/transcribe
  - Receives audio + language
  - Immediately returns { job_id, status: "processing" }
  - Whisper runs in a background daemon thread

GET /api/audiosync/transcribe/{job_id}
  - Returns { status, result, error }
  - Poll every 3-5 s until status is "done" or "error"

Why async?
  Whisper base on CPU takes ~1x real-time.  A 20-min audio takes ~20 min.
  Returning a job_id immediately avoids proxy/browser timeouts on large files.
  The frontend sends a downsampled 16-kHz mono WAV (Whisper's native format),
  which is ~3-8x smaller than the original, also reducing upload time.
"""
import os
import tempfile
import threading
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

router = APIRouter(tags=["audiosync"])

# ── Whisper model name (override with env var AUDIOSYNC_WHISPER_MODEL) ────────
WHISPER_MODEL_NAME = os.getenv("AUDIOSYNC_WHISPER_MODEL", "base")

_model_cache: dict = {}
_model_lock = threading.Lock()


def _load_model():
    with _model_lock:
        if WHISPER_MODEL_NAME not in _model_cache:
            try:
                import whisper as _w
                _model_cache[WHISPER_MODEL_NAME] = _w.load_model(WHISPER_MODEL_NAME)
            except Exception as exc:
                raise RuntimeError(str(exc)) from exc
    return _model_cache[WHISPER_MODEL_NAME]


# ── In-memory job store ───────────────────────────────────────────────────────
# { job_id: { status, result, error, created_at } }
_jobs: dict = {}
_jobs_lock = threading.Lock()

JOB_TTL = 7200  # seconds — clean up jobs older than 2 hours


def _cleanup_old_jobs():
    cutoff = time.time() - JOB_TTL
    with _jobs_lock:
        stale = [k for k, v in _jobs.items() if v.get("created_at", 0) < cutoff]
        for k in stale:
            del _jobs[k]


# ── Background transcription thread ──────────────────────────────────────────

def _result_to_sentences(result: dict) -> list[dict]:
    return [
        {
            "text":  seg["text"].strip(),
            "start": round(seg["start"], 3),
            "end":   round(seg["end"],   3),
        }
        for seg in result.get("segments", [])
        if seg.get("text", "").strip()
    ]


def _run_job(job_id: str, audio_bytes: bytes, filename: str, language: str):
    """Daemon thread: write temp file → run Whisper → store result."""
    suffix   = Path(filename or "audio.wav").suffix or ".wav"
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(audio_bytes)
            tmp_path = tmp.name

        lang  = language if language not in ("auto", "") else None
        model = _load_model()
        result = model.transcribe(
            tmp_path,
            language=language,
            word_timestamps=True,
            verbose=False,
            fp16=False,
        )

        sentences = _result_to_sentences(result)
        words = [
            {"word": w["word"], "start": round(w["start"], 3), "end": round(w["end"], 3)}
            for seg in result.get("segments", [])
            for w in seg.get("words", [])
        ]

        with _jobs_lock:
            _jobs[job_id].update({
                "status": "done",
                "result": {
                    "text":      result.get("text", "").strip(),
                    "sentences": sentences,
                    "words":     words,
                },
            })

    except Exception as exc:
        with _jobs_lock:
            _jobs[job_id].update({"status": "error", "error": str(exc)})
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/api/audiosync/transcribe")
async def transcribe_start(
    file: UploadFile = File(...),
    language: str    = Form("es"),
):
    """
    Start an async transcription job.
    Returns { job_id, status: "processing" } immediately.
    The client should poll GET /api/audiosync/transcribe/{job_id}.
    """
    try:
        import whisper  # noqa: F401
    except ImportError:
        raise HTTPException(503, "Whisper no está disponible en este servidor")

    _cleanup_old_jobs()

    audio_bytes = await file.read()
    job_id      = str(uuid.uuid4())

    with _jobs_lock:
        _jobs[job_id] = {
            "status":     "processing",
            "result":     None,
            "error":      None,
            "created_at": time.time(),
        }

    threading.Thread(
        target=_run_job,
        args=(job_id, audio_bytes, file.filename or "audio.wav", language),
        daemon=True,
    ).start()

    return {"job_id": job_id, "status": "processing"}


@router.get("/api/audiosync/transcribe/{job_id}")
async def transcribe_poll(job_id: str):
    """
    Poll the status of a transcription job.
    Returns { status, result, error }.
    status is one of: "processing" | "done" | "error"
    """
    with _jobs_lock:
        job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job no encontrado o expirado")
    return {
        "status": job["status"],
        "result": job.get("result"),
        "error":  job.get("error"),
    }

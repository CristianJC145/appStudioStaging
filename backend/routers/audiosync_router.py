"""
AudioSync — Transcription endpoint (async job queue)

POST /api/audiosync/transcribe
  - Receives audio + language
  - Immediately returns { job_id, status: "processing" }
  - WhisperX runs in a background daemon thread

GET /api/audiosync/transcribe/{job_id}
  - Returns { status, result, error }
  - Poll every 3-5 s until status is "done" or "error"

Why async?
  WhisperX on CPU takes ~1x real-time.  A 20-min audio takes ~20 min.
  Returning a job_id immediately avoids proxy/browser timeouts on large files.
  The frontend sends a downsampled 16-kHz mono WAV (Whisper's native format),
  which is ~3-8x smaller than the original, also reducing upload time.
"""
import gc
import os
import tempfile
import threading
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

router = APIRouter(tags=["audiosync"])

# ── WhisperX configuration for CPU-only VPS ──────────────────────────────────
WHISPER_MODEL_NAME = os.getenv("AUDIOSYNC_WHISPER_MODEL", "base")
DEVICE             = "cpu"
COMPUTE_TYPE       = "int8"
BATCH_SIZE         = 1

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

def _run_job(job_id: str, audio_bytes: bytes, filename: str, language: str):
    """Daemon thread: write temp file → WhisperX transcribe + align → store result."""
    suffix   = Path(filename or "audio.wav").suffix or ".wav"
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(audio_bytes)
            tmp_path = tmp.name

        lang = language if language not in ("auto", "") else None

        import whisperx

        # Step 1 — Transcribe
        model  = whisperx.load_model(WHISPER_MODEL_NAME, device=DEVICE, compute_type=COMPUTE_TYPE)
        result = model.transcribe(tmp_path, batch_size=BATCH_SIZE, language=lang)
        detected_lang = result.get("language", lang or "es")
        del model
        gc.collect()

        # Step 2 — Forced alignment (word-level timestamps)
        model_a, metadata = whisperx.load_align_model(
            language_code=detected_lang, device=DEVICE
        )
        result = whisperx.align(
            result["segments"], model_a, metadata, tmp_path,
            device=DEVICE, return_char_alignments=False,
        )
        del model_a
        gc.collect()

        # Format sentences from aligned segments
        sentences = []
        for seg in result.get("segments", []):
            text = seg.get("text", "").strip()
            if text and "start" in seg and "end" in seg:
                sentences.append({
                    "text":  text,
                    "start": round(seg["start"], 3),
                    "end":   round(seg["end"],   3),
                })
                
        raw_words = []
        for seg in result.get("segments", []):
            for w in seg.get("words", []):
                if "start" in w and "end" in w:
                    raw_words.append(w)

        # Format words — only include words that have both start AND end attributes
        words = []
        TAIL_PADDING = 0.150  # 150 milisegundos extra para capturar la "s" y la respiración
        
        for i, w in enumerate(raw_words):
            start = w["start"]
            base_end = w["end"]
            
            # Seguro contra colisiones: no extenderse más allá del inicio de la palabra siguiente
            if i < len(raw_words) - 1:
                next_start = raw_words[i + 1]["start"]
                # Tomamos el tiempo base + padding, pero NUNCA pisamos la siguiente palabra
                safe_end = min(base_end + TAIL_PADDING, next_start)
            else:
                # Si es la última palabra del audio, aplicamos el padding libremente
                safe_end = base_end + TAIL_PADDING

            words.append({
                "word":  w["word"],
                "start": round(start, 3),
                "end":   round(safe_end, 3),
            })

        with _jobs_lock:
            _jobs[job_id].update({
                "status": "done",
                "result": {
                    "text":      " ".join(s["text"] for s in sentences),
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
        import whisperx  # noqa: F401
    except ImportError:
        raise HTTPException(503, "WhisperX no está disponible en este servidor")

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

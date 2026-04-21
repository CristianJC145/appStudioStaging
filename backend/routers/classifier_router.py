"""
Classifier Router — FastAPI endpoints for the AI audio classifier.

GET  /classifier/status/{user_id}
POST /classifier/evaluate
POST /classifier/feedback
GET  /classifier/resumen/{user_id}/{segmento}
"""
import threading
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

try:
    from classifier.storage   import obtener_status_completo, obtener_resumen, obtener_umbral, guardar_ejemplo, borrar_segmento
    from classifier.classifier import clasificar_audio
    from classifier.extractor  import get_cached_features
    from classifier.summarizer import verificar_y_regenerar_resumen, limpiar_cache_segmento
    CLASSIFIER_AVAILABLE = True
except ImportError as _e:
    CLASSIFIER_AVAILABLE = False
    print(f"[classifier_router] Classifier modules not available: {_e}")

router = APIRouter(prefix="/classifier", tags=["classifier"])

# Section → DB segmento mapping
_SEG_MAP = {"intro": "intro", "afirm": "afirmaciones", "medit": "meditacion"}
# Frontend decision → DB decision mapping
_DEC_MAP = {
    "ok": "aprobado", "aprobado": "aprobado",
    "regenerate": "rechazado", "rechazado": "rechazado",
    "skip": "rechazado",
}


class EvaluateBody(BaseModel):
    user_id:  int
    segmento: str
    features: dict
    texto:    str


class FeedbackBody(BaseModel):
    job_id:        str
    section:       str
    index:         int
    decision:      str
    user_id:       Optional[int] = None
    language_code: str = "es"
    calidad_score: Optional[int] = None   # 1-5 stars (approved audios)
    razon_rechazo: Optional[list] = None  # label array (rejected audios)


@router.get("/status/{user_id}")
def get_classifier_status(user_id: int, language_code: str = Query("es")):
    """Learning status for all segments of a user, filtered by language."""
    if not CLASSIFIER_AVAILABLE:
        return {"user_id": user_id, "segmentos": {}, "language_code": language_code}
    try:
        status = obtener_status_completo(user_id, language_code)
        return {"user_id": user_id, "segmentos": status, "language_code": language_code}
    except Exception as exc:
        raise HTTPException(500, str(exc))


@router.post("/evaluate")
def evaluate_audio(body: EvaluateBody):
    """Evaluate a single audio fragment using the classifier."""
    if not CLASSIFIER_AVAILABLE:
        return {"modo": "sin_datos", "decision": None, "confianza": None, "razon": None}
    try:
        return clasificar_audio(body.user_id, body.segmento, body.features, body.texto)
    except Exception as exc:
        raise HTTPException(500, str(exc))


@router.post("/feedback")
def register_feedback(body: FeedbackBody):
    """Register a user decision as a training example."""
    if not CLASSIFIER_AVAILABLE:
        return {"ok": False, "reason": "classifier not available"}

    user_id = body.user_id
    if not user_id:
        return {"ok": False, "reason": "user_id required"}

    try:
        segmento = _SEG_MAP.get(body.section, body.section)
        decision = _DEC_MAP.get(body.decision, "rechazado")

        features = get_cached_features(body.job_id, body.section, body.index)
        if not features:
            return {"ok": False, "reason": "features not cached yet"}

        ok = guardar_ejemplo(
            user_id, segmento, features, decision,
            intento=1,
            params_elevenlabs=features.get("params_elevenlabs") or {},
            language_code=body.language_code,
            calidad_score=body.calidad_score,
            razon_rechazo=body.razon_rechazo,
        )
        if ok:
            threading.Thread(
                target=verificar_y_regenerar_resumen,
                args=(user_id, segmento, body.language_code),
                daemon=True,
            ).start()
        return {"ok": ok}
    except Exception as exc:
        raise HTTPException(500, str(exc))


_VALID_SEGMENTOS = {"intro", "meditacion", "afirmaciones"}

@router.delete("/reset/{user_id}/{segmento}")
def reset_segmento(user_id: int, segmento: str, language_code: str = Query("es")):
    """Delete all training data and summary for a user/segment/language."""
    if not CLASSIFIER_AVAILABLE:
        raise HTTPException(503, "Classifier not available")
    if segmento not in _VALID_SEGMENTOS:
        raise HTTPException(400, f"segmento must be one of {_VALID_SEGMENTOS}")
    try:
        result = borrar_segmento(user_id, segmento, language_code)
        limpiar_cache_segmento(user_id, segmento, language_code)
        return {
            "ok": True,
            "user_id": user_id,
            "segmento": segmento,
            "language_code": language_code,
            "deleted": result,
        }
    except Exception as exc:
        raise HTTPException(500, str(exc))


@router.get("/resumen/{user_id}/{segmento}")
def get_resumen(user_id: int, segmento: str):
    """Return the current distilled summary (for debugging)."""
    if not CLASSIFIER_AVAILABLE:
        return {"umbral": "sin_datos", "resumen": None}
    try:
        return {
            "umbral":  obtener_umbral(user_id, segmento),
            "resumen": obtener_resumen(user_id, segmento),
        }
    except Exception as exc:
        raise HTTPException(500, str(exc))

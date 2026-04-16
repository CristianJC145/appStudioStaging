"""
Classifier Regenerator — Auto-regenerates audio when the classifier rejects it.
Maximum 3 attempts per fragment, adjusting ElevenLabs params between attempts.
If still rejected → escalates to user with badge "revisar".
"""
import copy
from typing import Optional, Callable, TYPE_CHECKING

from classifier.extractor import extraer_features_audio
from classifier.classifier import clasificar_audio
from classifier.storage import guardar_ejemplo

if TYPE_CHECKING:
    from pydub import AudioSegment


def regenerar_con_clasificador(
    texto: str,
    segmento: str,
    params_originales: dict,
    cfg,
    user_id: int,
    audio_fn: Callable,
    max_intentos: int = 3,
) -> dict:
    """
    Attempt to produce a classifier-approved audio in up to max_intentos tries.

    audio_fn(texto: str, cfg) → AudioSegment | None
        A callable that generates audio given text and config.

    Returns:
        {
            "audio":          AudioSegment | None,
            "decision":       "aprobado" | "escalar_usuario",
            "intento_final":  int,
            "confianza":      float,
            "razon":          str,
        }
    """
    params_actuales   = dict(params_originales)
    ultimo_audio      = None
    ultima_confianza  = 0
    ultima_razon      = ""

    for intento in range(1, max_intentos + 1):
        cfg_ajustado = _aplicar_params(cfg, params_actuales)

        audio = audio_fn(texto, cfg_ajustado)
        if audio is None:
            continue

        features = extraer_features_audio(audio, texto)
        features["params_elevenlabs"] = params_actuales

        resultado       = clasificar_audio(user_id, segmento, features, texto)
        ultima_confianza = resultado.get("confianza") or 0
        ultima_razon     = resultado.get("razon")     or ""
        ultimo_audio     = audio
        decision         = resultado.get("decision")

        if decision == "aprobado" or resultado.get("modo") == "sin_datos":
            guardar_ejemplo(
                user_id, segmento, features,
                "aprobado", intento, params_actuales,
            )
            return {
                "audio":         audio,
                "decision":      "aprobado",
                "intento_final": intento,
                "confianza":     ultima_confianza,
                "razon":         ultima_razon,
            }

        # Rejected — save example and adjust params for next attempt
        guardar_ejemplo(
            user_id, segmento, features,
            "rechazado", intento, params_actuales,
        )
        params_sug = resultado.get("params_sugeridos") or {}
        if params_sug:
            params_actuales = _merge_params(params_actuales, params_sug)

    return {
        "audio":         ultimo_audio,
        "decision":      "escalar_usuario",
        "intento_final": max_intentos,
        "confianza":     ultima_confianza,
        "razon":         ultima_razon,
    }


def _aplicar_params(cfg, params: dict):
    """Return a deep-copied cfg with adjusted voice params."""
    cfg_c = copy.deepcopy(cfg)
    if params.get("speed") is not None:
        # afirm_voice_speed is the generic speed field used by regenerator
        cfg_c.afirm_voice_speed = float(params["speed"])
    if params.get("stability") is not None:
        cfg_c.voice_settings.stability = float(params["stability"])
    if params.get("similarity_boost") is not None:
        cfg_c.voice_settings.similarity_boost = float(params["similarity_boost"])
    return cfg_c


def _merge_params(current: dict, suggested: dict) -> dict:
    result = dict(current)
    for k, v in suggested.items():
        if v is not None:
            result[k] = v
    return result

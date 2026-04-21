"""
Classifier Main Module — Uses Claude API to evaluate audio quality
based on distilled user preferences and acoustic deep-learning metrics.

Output format:
  {
    "modo":                str,   # progression level
    "decision":            str,   # "aprobado" | "rechazado" | None
    "confianza":           int,   # 0-100 | None
    "razon_principal":     str,   # label tag | None
    "explicacion_detallada": str, # human-readable XAI explanation | None
    "params_sugeridos":    dict,  # ElevenLabs param suggestions | None
  }

Progression levels (based on training data threshold):
  sin_datos  → Aprendiendo  (<30 examples)
  aceptable  → Copiloto     (30-74)
  bueno      → Semi-auto    (75-149, suggests at ≥70% confidence)
  excelente  → Autónomo     (150-299, can auto-approve at ≥85% confidence)
  pro        → Pro          (300+, maximum precision)

Only Autónomo and Pro levels should trigger auto-regeneration without human review.
"""
import os
import json

try:
    import anthropic
    ANTHROPIC_AVAILABLE = True
except ImportError:
    ANTHROPIC_AVAILABLE = False

from classifier.storage import obtener_umbral, obtener_resumen

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
_MODEL = "claude-haiku-4-5-20251001"

# Progression level labels
_NIVEL_MAP = {
    "sin_datos": "Aprendiendo",
    "aceptable": "Copiloto",
    "bueno":     "Semi-auto",
    "excelente": "Autónomo",
    "pro":       "Pro",
}

_RESULT_SIN_DATOS = {
    "modo":                   "Aprendiendo",
    "decision":               None,
    "confianza":              None,
    "razon_principal":        None,
    "explicacion_detallada":  None,
    "params_sugeridos":       None,
}


def clasificar_audio(
    user_id: int,
    segmento: str,
    features: dict,
    texto: str,
    language_code: str = "es",
) -> dict:
    """
    Classify an audio fragment against the user's learned preferences.
    Returns classification result with XAI explanation.
    """
    if not ANTHROPIC_AVAILABLE or not ANTHROPIC_API_KEY:
        return _RESULT_SIN_DATOS

    try:
        umbral = obtener_umbral(user_id, segmento, language_code)
        nivel  = _NIVEL_MAP.get(umbral, "Aprendiendo")

        if umbral == "sin_datos":
            return _RESULT_SIN_DATOS

        resumen = obtener_resumen(user_id, segmento, language_code)
        if not resumen:
            return {**_RESULT_SIN_DATOS, "modo": nivel}

        decision, confianza, razon_principal, explicacion, params_sug = _llamar_claude(
            segmento, features, texto, resumen, nivel
        )
        return {
            "modo":                  nivel,
            "decision":              decision,
            "confianza":             confianza,
            "razon_principal":       razon_principal,
            "explicacion_detallada": explicacion,
            "params_sugeridos":      params_sug,
        }
    except Exception as exc:
        print(f"[classifier.classifier] clasificar_audio error: {exc}")
        return _RESULT_SIN_DATOS


def _llamar_claude(segmento, features, texto, resumen, nivel) -> tuple:
    """
    Call Claude API with acoustic metrics + user preference summary.
    Returns (decision, confianza, razon_principal, explicacion_detallada, params_sugeridos).
    """
    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

    # Build concise acoustic metrics block (exclude ElevenLabs params to avoid causal hallucinations)
    metricas = {
        "duracion_seg":       features.get("duracion_seg", 0),
        "wpm":                features.get("wpm", 0),
        "densidad_silencios": features.get("densidad_silencios", 0),
        "energia_promedio":   features.get("energia_promedio", 0),
        "variacion_pitch":    features.get("variacion_pitch", 0),
        "jitter":             features.get("jitter"),
        "shimmer":            features.get("shimmer"),
        "spectral_centroid":  features.get("spectral_centroid"),
        "nisqa_score":        features.get("nisqa_score"),
        "coincidencia_texto": features.get("coincidencia_texto"),
    }

    prompt = (
        f"Eres un clasificador de audio para meditación guiada. "
        f"Nivel actual del sistema: {nivel}.\n\n"
        f"RESUMEN DE PREFERENCIAS DEL USUARIO (segmento: {segmento}):\n"
        f"{json.dumps(resumen, ensure_ascii=False)}\n\n"
        f"AUDIO A EVALUAR:\n"
        f"- Texto original: \"{texto[:200]}\"\n"
        f"- Texto transcrito: \"{features.get('texto_transcrito') or 'no disponible'}\"\n"
        f"- Métricas acústicas: {json.dumps(metricas, ensure_ascii=False)}\n\n"
        "Etiquetas válidas para razon_principal: "
        "voz_robotica, velocidad_lenta, velocidad_rapida, mala_pronunciacion, calidad_ok\n\n"
        "Responde SOLO con este JSON sin texto adicional:\n"
        '{"decision":"aprobado","confianza":75,'
        '"razon_principal":"calidad_ok",'
        '"explicacion_detallada":"Texto breve explicando qué métricas concretas (WPM, NISQA, Jitter) llevaron a esta decisión.",'
        '"params_sugeridos":{"speed":null,"stability":null,"similarity_boost":null}}'
    )

    response = client.messages.create(
        model=_MODEL,
        max_tokens=350,
        messages=[{"role": "user", "content": prompt}],
    )
    raw = response.content[0].text.strip()

    if raw.startswith("```"):
        parts = raw.split("```")
        raw = parts[1] if len(parts) > 1 else raw
        if raw.startswith("json"):
            raw = raw[4:]
        raw = raw.strip()

    data = json.loads(raw)
    return (
        data.get("decision", "aprobado"),
        min(100, max(0, int(data.get("confianza", 75)))),
        data.get("razon_principal", "calidad_ok"),
        data.get("explicacion_detallada", ""),
        data.get("params_sugeridos"),
    )

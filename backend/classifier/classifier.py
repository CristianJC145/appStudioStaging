"""
Classifier Main Module — Uses Claude API to evaluate audio quality
based on distilled user preferences.

Degrades silently to {"modo": "sin_datos", "decision": None} on any failure.
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
# Use Haiku for fast, cheap classification (~$0.0002 per evaluation)
_MODEL = "claude-haiku-4-5-20251001"

_RESULT_SIN_DATOS = {
    "modo":            "sin_datos",
    "decision":        None,
    "confianza":       None,
    "razon":           None,
    "params_sugeridos": None,
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

    Returns:
        {
            "modo":             "sin_datos" | "aceptable" | "bueno" | "excelente" | "pro",
            "decision":         "aprobado" | "rechazado" | None,
            "confianza":        0-100 | None,
            "razon":            str | None,
            "params_sugeridos": {"speed": float|None, "stability": float|None, ...} | None,
        }
    """
    if not ANTHROPIC_AVAILABLE or not ANTHROPIC_API_KEY:
        return _RESULT_SIN_DATOS

    try:
        umbral = obtener_umbral(user_id, segmento, language_code)
        if umbral == "sin_datos":
            return _RESULT_SIN_DATOS

        resumen = obtener_resumen(user_id, segmento, language_code)
        if not resumen:
            return {**_RESULT_SIN_DATOS, "modo": umbral}

        decision, confianza, razon, params_sug = _llamar_claude(
            segmento, features, texto, resumen
        )
        return {
            "modo":             umbral,
            "decision":         decision,
            "confianza":        confianza,
            "razon":            razon,
            "params_sugeridos": params_sug,
        }
    except Exception as exc:
        print(f"[classifier.classifier] clasificar_audio error: {exc}")
        return _RESULT_SIN_DATOS


def _llamar_claude(segmento, features, texto, resumen) -> tuple:
    """Call Claude API. Returns (decision, confianza, razon, params_sugeridos)."""
    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    params = features.get("params_elevenlabs") or {}

    prompt = (
        f"Eres un clasificador de audio para meditación guiada en español o inglés.\n"
        f"Evalúas fragmentos de texto narrado (2-20 segundos cada uno).\n\n"
        f"RESUMEN DE PREFERENCIAS DEL USUARIO (segmento: {segmento}):\n"
        f"{json.dumps(resumen, ensure_ascii=False)}\n\n"
        f"AUDIO A EVALUAR:\n"
        f"- Texto original: \"{texto[:200]}\"\n"
        f"- Texto transcrito: \"{features.get('texto_transcrito') or 'no disponible'}\"\n"
        f"- Coincidencia: {features.get('coincidencia_texto') or 'n/a'}%\n"
        f"- Duración: {features.get('duracion_seg', 0)}s\n"
        f"- Tempo: {features.get('tempo_bpm', 0)} BPM\n"
        f"- Energía promedio: {features.get('energia_promedio', 0)}\n"
        f"- Variación de pitch: {features.get('variacion_pitch', 0)}\n"
        f"- Silencios detectados: {features.get('num_silencios', 0)}\n"
        f"- Duración promedio silencio: {features.get('duracion_promedio_silencio_seg', 0)}s\n"
        f"- Parámetros ElevenLabs usados: {json.dumps(params)}\n\n"
        "Responde SOLO con este JSON sin texto adicional:\n"
        '{"decision":"aprobado","confianza":75,"razon":"breve","params_sugeridos":{"speed":null,"stability":null,"similarity_boost":null}}'
    )

    response = client.messages.create(
        model=_MODEL,
        max_tokens=220,
        messages=[{"role": "user", "content": prompt}],
    )
    raw = response.content[0].text.strip()

    # Strip markdown code fences if present
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
        data.get("razon", ""),
        data.get("params_sugeridos"),
    )

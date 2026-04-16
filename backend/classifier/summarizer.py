"""
Classifier Summarizer — Generates a compact distilled summary of user preferences
using Claude API every 20 new training examples per segment.

Cost: ~$0.04 per summary regeneration (uses Haiku).
Runs entirely in daemon background threads.
"""
import os
import json
import threading

try:
    import anthropic
    ANTHROPIC_AVAILABLE = True
except ImportError:
    ANTHROPIC_AVAILABLE = False

from classifier.storage import (
    obtener_ejemplos_para_resumen,
    guardar_resumen,
    obtener_resumen,
    obtener_conteo_por_segmento,
)

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
_MODEL = "claude-haiku-4-5-20251001"

# Tracks how many examples were present when we last generated a summary
# Key: f"{user_id}_{segmento}" → int
_last_summarized      : dict[str, int] = {}
_last_summarized_lock = threading.Lock()


def verificar_y_regenerar_resumen(user_id: int, segmento: str):
    """
    Check if a new summary is needed (every 20 new examples, min 30 total).
    If so, spawn a background thread to regenerate it.
    Safe to call from any thread.
    """
    key = f"{user_id}_{segmento}"
    try:
        conteos  = obtener_conteo_por_segmento(user_id)
        n_actual = conteos.get(segmento, 0)

        if n_actual < 30:
            return

        with _last_summarized_lock:
            n_previo = _last_summarized.get(key, 0)
            if n_actual - n_previo < 20:
                return
            _last_summarized[key] = n_actual

        threading.Thread(
            target=_generar_resumen,
            args=(user_id, segmento, n_actual),
            daemon=True,
        ).start()
    except Exception as exc:
        print(f"[classifier.summarizer] verificar error: {exc}")


def _generar_resumen(user_id: int, segmento: str, n_actual: int):
    """Build and persist a new distilled summary via Claude API."""
    if not ANTHROPIC_AVAILABLE or not ANTHROPIC_API_KEY:
        return

    try:
        ejemplos = obtener_ejemplos_para_resumen(user_id, segmento, limit=200)
        if len(ejemplos) < 20:
            return

        resumen_previo = obtener_resumen(user_id, segmento)
        version        = (resumen_previo.get("_version", 0) + 1) if resumen_previo else 1

        aprobados  = [e for e in ejemplos if e.get("decision") == "aprobado"]
        rechazados = [e for e in ejemplos if e.get("decision") == "rechazado"]

        fkeys = [
            "duracion_seg", "tempo_bpm", "energia_promedio", "variacion_pitch",
            "num_silencios", "duracion_promedio_silencio_seg", "coincidencia_texto",
        ]

        def _stats(lst):
            out = {}
            for k in fkeys:
                vals = [e[k] for e in lst if e.get(k) is not None]
                if vals:
                    out[k] = {
                        "min":  round(min(vals),              4),
                        "max":  round(max(vals),              4),
                        "mean": round(sum(vals) / len(vals),  4),
                    }
            return out

        datos = {
            "total":                len(ejemplos),
            "aprobados":            len(aprobados),
            "rechazados":           len(rechazados),
            "features_aprobados":   _stats(aprobados),
            "features_rechazados":  _stats(rechazados),
            "muestra_rechazos": [
                {
                    "duracion":     e.get("duracion_seg"),
                    "tempo":        e.get("tempo_bpm"),
                    "coincidencia": e.get("coincidencia_texto"),
                    "params":       e.get("params_elevenlabs"),
                    "texto":        (e.get("texto_original") or "")[:60],
                }
                for e in rechazados[:12]
            ],
        }

        client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
        prompt = (
            f"Analiza estos datos de entrenamiento de un clasificador de audio de meditación.\n"
            f"El usuario ha evaluado {len(ejemplos)} fragmentos del segmento '{segmento}'.\n\n"
            f"DATOS:\n{json.dumps(datos, ensure_ascii=False)}\n\n"
            "Genera un resumen destilado. Responde SOLO con este JSON sin texto adicional:\n"
            "{\n"
            f'  "segmento": "{segmento}",\n'
            f'  "version": {version},\n'
            f'  "ejemplos_procesados": {n_actual},\n'
            '  "confianza_del_resumen": <0-100>,\n'
            '  "patrones_aprobados": {\n'
            '    "tempo_bpm": {"min": 0, "max": 0, "optimo": 0},\n'
            '    "energia_promedio": {"min": 0, "max": 0},\n'
            '    "variacion_pitch": {"max": 0},\n'
            '    "num_silencios": {"min": 0},\n'
            '    "coincidencia_texto": {"min": 0},\n'
            '    "duracion_seg": {"min": 0, "max": 0}\n'
            '  },\n'
            '  "causas_rechazo_frecuentes": [{"causa": "", "frecuencia_porcentaje": 0}],\n'
            '  "patrones_cualitativos": [""],\n'
            '  "params_elevenlabs_optimos": {\n'
            '    "stability": {"min": 0, "max": 0, "optimo": 0},\n'
            '    "similarity_boost": {"min": 0, "max": 0},\n'
            '    "speed": {"min": 0, "max": 0, "optimo": 0}\n'
            '  }\n'
            "}"
        )

        response = client.messages.create(
            model=_MODEL,
            max_tokens=900,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = response.content[0].text.strip()
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
            raw = raw.strip()

        nuevo = json.loads(raw)
        guardar_resumen(user_id, segmento, nuevo, version)
        print(
            f"[classifier.summarizer] Resumen v{version} generado "
            f"para user={user_id} segmento={segmento}"
        )

    except Exception as exc:
        print(f"[classifier.summarizer] _generar_resumen error: {exc}")

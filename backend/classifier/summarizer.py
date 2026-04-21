"""
Classifier Summarizer — Generates a compact distilled summary of user preferences
using Claude API every 20 new training examples per segment.

The summary correlates acoustic metrics (WPM, NISQA, Jitter, Shimmer, etc.)
with human labels (calidad_score, razon_rechazo) to build the classifier's
acoustic rule set. Runs entirely in daemon background threads.
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

_last_summarized      : dict[str, int] = {}
_last_summarized_lock = threading.Lock()


def limpiar_cache_segmento(user_id: int, segmento: str, language_code: str = "es"):
    key = f"{user_id}_{segmento}_{language_code}"
    with _last_summarized_lock:
        _last_summarized.pop(key, None)


def verificar_y_regenerar_resumen(user_id: int, segmento: str, language_code: str = "es"):
    """
    Check if a new summary is needed (every 20 new examples, min 30 total).
    If so, spawn a background thread to regenerate it.
    """
    key = f"{user_id}_{segmento}_{language_code}"
    try:
        conteos  = obtener_conteo_por_segmento(user_id, language_code)
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
            args=(user_id, segmento, n_actual, language_code),
            daemon=True,
        ).start()
    except Exception as exc:
        print(f"[classifier.summarizer] verificar error: {exc}")


def _generar_resumen(user_id: int, segmento: str, n_actual: int, language_code: str = "es"):
    """Build and persist a new distilled summary via Claude API."""
    if not ANTHROPIC_AVAILABLE or not ANTHROPIC_API_KEY:
        return

    try:
        ejemplos = obtener_ejemplos_para_resumen(user_id, segmento, limit=200, language_code=language_code)
        if len(ejemplos) < 20:
            return

        resumen_previo = obtener_resumen(user_id, segmento, language_code)
        version        = (resumen_previo.get("_version", 0) + 1) if resumen_previo else 1

        aprobados  = [e for e in ejemplos if e.get("decision") == "aprobado"]
        rechazados = [e for e in ejemplos if e.get("decision") == "rechazado"]

        # Acoustic metrics used for statistical analysis
        fkeys = [
            "duracion_seg", "wpm", "densidad_silencios",
            "energia_promedio", "variacion_pitch",
            "jitter", "shimmer", "spectral_centroid", "nisqa_score",
            "coincidencia_texto",
        ]

        def _stats(lst):
            out = {}
            for k in fkeys:
                vals = [e[k] for e in lst if e.get(k) is not None]
                if vals:
                    out[k] = {
                        "min":  round(min(vals),             4),
                        "max":  round(max(vals),             4),
                        "mean": round(sum(vals) / len(vals), 4),
                    }
            return out

        # Collect human quality labels from approved audios (calidad_score)
        calidad_scores = [e["calidad_score"] for e in aprobados if e.get("calidad_score")]
        perfil_ideal = [e for e in aprobados if e.get("calidad_score") and e["calidad_score"] >= 4]

        # Collect rejection reason labels
        razones_rechazo = []
        for e in rechazados:
            rr = e.get("razon_rechazo")
            if rr:
                if isinstance(rr, str):
                    try:
                        rr = json.loads(rr)
                    except Exception:
                        rr = []
                if isinstance(rr, list):
                    razones_rechazo.extend(rr)

        # Count label frequencies
        from collections import Counter
        label_counts = dict(Counter(razones_rechazo))

        datos = {
            "total":              len(ejemplos),
            "aprobados":          len(aprobados),
            "rechazados":         len(rechazados),
            "features_aprobados": _stats(aprobados),
            "features_rechazados": _stats(rechazados),
            "features_perfil_ideal_4_5_estrellas": _stats(perfil_ideal) if perfil_ideal else {},
            "calidad_score_promedio": round(sum(calidad_scores) / len(calidad_scores), 2) if calidad_scores else None,
            "razon_rechazo_frecuencias": label_counts,
            "muestra_rechazos": [
                {
                    "duracion":           e.get("duracion_seg"),
                    "wpm":                e.get("wpm"),
                    "nisqa_score":        e.get("nisqa_score"),
                    "jitter":             e.get("jitter"),
                    "spectral_centroid":  e.get("spectral_centroid"),
                    "coincidencia_texto": e.get("coincidencia_texto"),
                    "razon_rechazo":      e.get("razon_rechazo"),
                    "texto":              (e.get("texto_original") or "")[:60],
                }
                for e in rechazados[:12]
            ],
        }

        client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
        prompt = (
            f"Analiza estos datos de entrenamiento de un clasificador de audio de meditación.\n"
            f"El usuario ha evaluado {len(ejemplos)} fragmentos del segmento '{segmento}'.\n\n"
            f"DATOS:\n{json.dumps(datos, ensure_ascii=False)}\n\n"
            "INSTRUCCIÓN CLAVE: Debes encontrar correlaciones entre las métricas acústicas y las "
            "etiquetas humanas. Ejemplos de reglas a buscar:\n"
            "- Si audios etiquetados 'voz_robotica' tienen nisqa_score < 3.0 y jitter alto → define esa regla.\n"
            "- Si audios etiquetados 'velocidad_lenta' tienen wpm < X → establece el umbral WPM ideal.\n"
            "- Define el 'perfil acústico ideal' analizando los audios con calidad_score de 4 y 5 estrellas.\n\n"
            "Genera un resumen destilado. Responde SOLO con este JSON sin texto adicional:\n"
            "{\n"
            f'  "segmento": "{segmento}",\n'
            f'  "version": {version},\n'
            f'  "ejemplos_procesados": {n_actual},\n'
            '  "confianza_del_resumen": <0-100>,\n'
            '  "perfil_acustico_ideal": {\n'
            '    "wpm": {"min": 0, "max": 0, "optimo": 0},\n'
            '    "nisqa_score": {"min": 0},\n'
            '    "jitter": {"max": 0},\n'
            '    "shimmer": {"max": 0},\n'
            '    "spectral_centroid": {"max": 0},\n'
            '    "densidad_silencios": {"min": 0, "max": 0},\n'
            '    "duracion_seg": {"min": 0, "max": 0}\n'
            '  },\n'
            '  "reglas_acusticas": [\n'
            '    {"etiqueta": "voz_robotica", "condicion": "nisqa_score < X y jitter > Y", "umbral_nisqa": 0, "umbral_jitter": 0},\n'
            '    {"etiqueta": "velocidad_lenta", "condicion": "wpm < X", "umbral_wpm": 0},\n'
            '    {"etiqueta": "velocidad_rapida", "condicion": "wpm > X", "umbral_wpm": 0},\n'
            '    {"etiqueta": "mala_pronunciacion", "condicion": "coincidencia_texto < 95", "umbral_coincidencia": 95}\n'
            '  ],\n'
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
            max_tokens=1200,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = response.content[0].text.strip()
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
            raw = raw.strip()

        nuevo = json.loads(raw)
        guardar_resumen(user_id, segmento, nuevo, version, language_code)
        print(
            f"[classifier.summarizer] Resumen v{version} generado "
            f"para user={user_id} segmento={segmento} lang={language_code}"
        )

    except Exception as exc:
        print(f"[classifier.summarizer] _generar_resumen error: {exc}")

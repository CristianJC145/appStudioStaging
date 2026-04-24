"""
Router de Automatización de Guiones
Toda la lógica de TTS, revisión y ensamblado de audio.
"""

import re
import os
import io
import json
import time
import uuid
import hashlib
import tempfile
import subprocess
import threading
import requests
from pathlib import Path
from typing import Optional
from collections import defaultdict

import statistics

import base64
import pymysql
import pymysql.cursors
from fastapi import APIRouter, HTTPException, BackgroundTasks
from fastapi.responses import FileResponse, StreamingResponse

# ── Clasificador de audio (opcional — degrada si no está disponible) ──────────
try:
    from classifier.extractor  import cachear_features_async, get_cached_features
    from classifier.classifier import clasificar_audio
    from classifier.storage    import guardar_ejemplo, obtener_umbral
    from classifier.summarizer import verificar_y_regenerar_resumen
    CLASSIFIER_AVAILABLE = True
except Exception as _clf_err:
    CLASSIFIER_AVAILABLE = False
    print(f"[guiones] Classifier not available: {_clf_err}")
from pydantic import BaseModel

try:
    from langdetect import detect as _langdetect
    LANGDETECT_AVAILABLE = True
except ImportError:
    LANGDETECT_AVAILABLE = False

try:
    from pydub import AudioSegment
    from pydub.silence import detect_silence, detect_leading_silence
    PYDUB_AVAILABLE = True
except ImportError:
    PYDUB_AVAILABLE = False

try:
    import whisper as _whisper_lib
    WHISPER_AVAILABLE = True
except ImportError:
    WHISPER_AVAILABLE = False

_whisper_model = None
WHISPER_MODEL_SIZE = "small"   # 244 MB, 99 idiomas, detección automática

def _get_whisper_model():
    global _whisper_model
    if _whisper_model is None:
        _whisper_model = _whisper_lib.load_model(WHISPER_MODEL_SIZE)
    return _whisper_model

router = APIRouter(prefix="/api")

# Contador de caracteres por hilo de generación (un job = un hilo)
_job_ctx = threading.local()

CARPETA_TEMP   = Path("temp_chunks")
CARPETA_SALIDA = Path("salida")
CARPETA_TEMP.mkdir(exist_ok=True)
CARPETA_SALIDA.mkdir(exist_ok=True)

# ── Persistencia: configuraciones ───────────────────────────────────────────
CONFIG_DIR      = Path("data") / "configs"
USER_PREFS_DIR  = Path("data") / "user_prefs"
CONFIG_DIR.mkdir(parents=True, exist_ok=True)
USER_PREFS_DIR.mkdir(parents=True, exist_ok=True)

# ── DB helpers (guiones config) ──────────────────────────────────────────────
def _db_conn():
    return pymysql.connect(
        host=os.getenv("DB_HOST", "app-studio_db"),
        port=int(os.getenv("DB_PORT", "3306")),
        user=os.getenv("DB_USER", "root"),
        password=os.getenv("DB_PASS", ""),
        database=os.getenv("DB_NAME", "studio_db"),
        cursorclass=pymysql.cursors.DictCursor,
        charset="utf8mb4",
        autocommit=True,
    )

def _ensure_config_table():
    try:
        conn = _db_conn()
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS guiones_config (
                    user_id INT NOT NULL PRIMARY KEY,
                    config_json JSON NOT NULL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)
        conn.close()
    except Exception as e:
        print(f"[guiones] DB config table init warning: {e}")

_ensure_config_table()

# ── Claves predefinidas del equipo ───────────────────────────────────────────
# Se leen de backend/.env — nunca hardcodear aquí.
# Formato en .env:
#   ELEVENLABS_KEY_1_NAME=Nombre visible
#   ELEVENLABS_KEY_1_API_KEY=sk-...
#   ELEVENLABS_KEY_1_VOICE_ID=abc123
#   ELEVENLABS_KEY_2_NAME=...  (continuar con 2, 3, 4...)
def _load_predefined_keys() -> list[dict]:
    keys = []
    i = 1
    while True:
        api_key = os.getenv(f"ELEVENLABS_KEY_{i}_API_KEY", "").strip()
        if not api_key:
            break
        keys.append({
            "name":     os.getenv(f"ELEVENLABS_KEY_{i}_NAME",     f"Clave {i}"),
            "api_key":  api_key,
            "voice_id": os.getenv(f"ELEVENLABS_KEY_{i}_VOICE_ID", ""),
        })
        i += 1
    return keys

PREDEFINED_KEYS = _load_predefined_keys()

def _get_subscription_info(api_key: str) -> dict:
    """Consulta /v1/user/subscription de ElevenLabs y devuelve info de créditos."""
    try:
        r = requests.get(
            "https://api.elevenlabs.io/v1/user/subscription",
            headers={"xi-api-key": api_key},
            timeout=10,
        )
        if r.status_code == 200:
            d = r.json()
            return {
                "character_count": d.get("character_count", 0),
                "character_limit": d.get("character_limit", 0),
                "tier": d.get("tier", ""),
                "next_reset": d.get("next_character_count_reset_unix", 0),
            }
    except Exception:
        pass
    return {}

# Mini-diccionario de frases de relleno para el calentamiento de voz.
WARMUP_FRASES: dict[str, list[str]] = {
    "es": [
        "Respira profundamente y siente cómo cada célula de tu cuerpo se llena de energía renovada.",
        "Empiezan a aparecer situaciones que se sienten exactamente como lo que imaginé.",
        "Tu voz fluye con naturalidad, con calidez y con una presencia serena.",
        "Siente la calma que se expande suavemente desde tu centro hacia todo tu ser.",
        "Permite que la paz interior guíe cada palabra que pronuncias.",
        "Estás presente, enfocado y en plena armonía contigo mismo.",
        "Tu energía es clara, tu mente está abierta.",
        "Respira y confía.",
    ],
    "en": [
        "Take a deep breath and feel how every cell in your body fills with renewed energy.",
        "Every thought you choose with intention opens a door toward your best self.",
        "Your voice flows naturally, with warmth and a calm, grounded presence.",
        "Feel the peace expanding gently from your center outward to your whole being.",
        "Allow your inner calm to guide every word you speak.",
        "You are present, focused, and in full harmony with yourself.",
        "Your energy is clear, your mind is open.",
        "Breathe and trust.",
    ],
}


def _detectar_idioma(texto: str) -> Optional[str]:
    """
    Detecta el idioma del texto usando langdetect.
    Usa los primeros 500 chars para rapidez.
    Devuelve el código ISO 639-1 (ej. 'es', 'en') o None si falla.
    """
    if not LANGDETECT_AVAILABLE or not texto.strip():
        return None
    try:
        return _langdetect(texto[:500])
    except Exception:
        return None


# =============================================================
#  WARMUP: funciones independientes por sección
# =============================================================

def _warmup_intro_medit(cfg: "Config") -> str:
    """
    Warmup para INTRO y MEDITACIÓN: una sola frase corta.
    Intro/medit tienen segmentos largos que ya cumplen min_chars por sí solos;
    el warmup solo necesita acondicionar la voz, no inflar el conteo de tokens.
    """
    if cfg.texto_calentamiento and cfg.texto_calentamiento.strip():
        return cfg.texto_calentamiento.strip()
    frases = WARMUP_FRASES.get(cfg.language_code, WARMUP_FRASES["es"])
    return frases[0]


def _warmup_afirm_regen(cfg: "Config", texto_afirm: str = "") -> str:
    """
    Warmup para REGENERACIÓN de afirmaciones individuales.
    Las afirmaciones pueden ser muy cortas; concatena frases del diccionario
    hasta que warmup + afirmación superen min_chars_parrafo, sin pasarse más
    de lo necesario para no quemar tokens de más.
    """
    if cfg.texto_calentamiento and cfg.texto_calentamiento.strip():
        return cfg.texto_calentamiento.strip()
    frases = WARMUP_FRASES.get(cfg.language_code, WARMUP_FRASES["es"])
    needed = max(0, cfg.min_chars_parrafo - len(texto_afirm))
    resultado = ""
    for frase in frases:
        resultado = (resultado + " " + frase).strip() if resultado else frase
        if len(resultado) >= needed:
            return resultado
    # Si agotamos el diccionario (needed muy alto), ciclar frases
    idx = 0
    while len(resultado) < needed:
        resultado = resultado + " " + frases[idx % len(frases)]
        idx += 1
    return resultado


# =============================================================
#  CONSTRUCTORES DE BLOQUES: independientes por sección
# =============================================================

def _bloques_intro(texto: str, cfg: "Config") -> list[str]:
    """
    Divide el texto de INTRO en bloques respetando min/max chars.
    Descuenta el overhead del warmup (una frase corta + break + \\n\\n).
    """
    warmup_overhead = len(_warmup_intro_medit(cfg)) + 23 if cfg.usar_calentamiento else 0
    return _construir_bloques(texto, cfg, warmup_overhead)


def _bloques_medit(texto: str, cfg: "Config") -> list[str]:
    """
    Divide el texto de MEDITACIÓN en bloques respetando min/max chars.
    Lógica idéntica a intro hoy; función propia para poder divergir después.
    """
    warmup_overhead = len(_warmup_intro_medit(cfg)) + 23 if cfg.usar_calentamiento else 0
    return _construir_bloques(texto, cfg, warmup_overhead)


# =============================================================
#  GENERADORES DE AUDIO: independientes por sección
# =============================================================

def _audio_intro(texto: str, carpeta: "Path", indice: int,
                 cfg: "Config", force_regen: bool = False) -> "Optional[AudioSegment]":
    """Genera (o carga de caché) el audio de un bloque de INTRO."""
    return cargar_oracion(texto, carpeta, "intro", indice,
                          cfg.intro_voice_speed, cfg,
                          force_regen=force_regen)


def _audio_medit(texto: str, carpeta: "Path", indice: int,
                 cfg: "Config", force_regen: bool = False) -> "Optional[AudioSegment]":
    """Genera (o carga de caché) el audio de un bloque de MEDITACIÓN."""
    return cargar_oracion(texto, carpeta, "medit", indice,
                          cfg.medit_voice_speed, cfg,
                          force_regen=force_regen)


jobs: dict[str, dict] = {}
job_events: dict[str, list] = defaultdict(list)
job_locks: dict[str, threading.Event] = {}

# =============================================================
#  MODELOS PYDANTIC
# =============================================================

class VoiceSettings(BaseModel):
    stability: float = 0.45
    similarity_boost: float = 0.95
    style: float = 0.01
    use_speaker_boost: bool = True

class Config(BaseModel):
    api_key: str = "dd15fc77bf3a163f41e678cf29f8018fc0c43e756081a6e4dcbd6bc66ae5e251"
    voice_id: str = "3fRg3Y6XXL8gnxYFuN1z"
    model_id: str = "eleven_multilingual_v2"
    language_code: str = "es"
    output_format: str = "pcm_44100"
    voice_settings: VoiceSettings = VoiceSettings()
    intro_voice_speed: float = 1.0
    afirm_voice_speed: float = 0.94
    medit_voice_speed: float = 0.90
    pausa_entre_oraciones: int = 400
    pausa_entre_afirmaciones: int = 5000
    pausa_intro_a_afirm: int = 2000
    pausa_afirm_a_medit: int = 3000
    pausa_entre_meditaciones: int = 5000
    # Calentamiento de voz (warmup)
    usar_calentamiento: bool = True
    texto_calentamiento: str = ""  # vacío = auto-selección por language_code
    # Post-proceso
    extend_silence: bool = False
    factor_coma: float = 1.0
    factor_punto: float = 1.2
    factor_suspensivos: float = 1.5
    silence_thresh_db: int = -40
    silence_min_ms: int = 80
    max_chars_parrafo: int = 290
    min_chars_parrafo: int = 220

class GenerateRequest(BaseModel):
    guion:   str
    config:  Config
    nombre:  str = "meditacion"
    user_id: Optional[int] = None   # for classifier training

class ReviewDecision(BaseModel):
    job_id: str
    section: str
    index: int
    decision: str
    new_text: Optional[str] = None
    calidad_score: Optional[int] = None      # 1-5 stars (approved audios)
    razon_rechazo: Optional[list] = None     # label array (rejected audios)

# =============================================================
#  LÓGICA DE AUDIO
# =============================================================

def silencio(ms: int, frame_rate: int = 44100, channels: int = 1) -> "AudioSegment":
    seg = AudioSegment.silent(duration=ms, frame_rate=frame_rate)
    if channels > 1:
        seg = seg.set_channels(channels)
    return seg

def hash_texto(texto: str, voice_speed: float, settings: dict, output_format: str = "") -> str:
    contenido = json.dumps(
        {"texto": texto, "settings": settings, "speed": voice_speed, "fmt": output_format},
        sort_keys=True
    )
    return hashlib.md5(contenido.encode()).hexdigest()[:10]

def ruta_cache(carpeta: Path, prefijo: str, indice: int, texto: str,
               voice_speed: float, settings: dict, output_format: str = "") -> Path:
    h = hash_texto(texto, voice_speed, settings, output_format)
    return carpeta / f"{prefijo}_{indice:05d}_{h}.wav"


def extender_silencios_internos(audio: "AudioSegment", cfg: Config) -> "AudioSegment":
    rangos = detect_silence(audio, min_silence_len=cfg.silence_min_ms,
                            silence_thresh=cfg.silence_thresh_db)
    if not rangos:
        return audio
    resultado = AudioSegment.empty()
    cursor = 0
    for inicio, fin in rangos:
        if inicio > cursor:
            resultado += audio[cursor:inicio]
        dur = fin - inicio
        factor = (cfg.factor_coma if dur < 400
                  else cfg.factor_punto if dur < 900
                  else cfg.factor_suspensivos)
        resultado += silencio(int(dur * factor))
        cursor = fin
    if cursor < len(audio):
        resultado += audio[cursor:]
    return resultado


def texto_a_audio_api(texto: str, ruta_salida: Path,
                      voice_speed: float, cfg: Config) -> bool:
    fmt = getattr(cfg, "output_format", "mp3_44100_128") or "mp3_44100_128"
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{cfg.voice_id}?output_format={fmt}"
    headers = {"xi-api-key": cfg.api_key, "Content-Type": "application/json"}
    texto_tts = texto.strip()
    payload = {
        "text": texto_tts,
        "model_id": cfg.model_id,
        "language_code": cfg.language_code,
        "voice_settings": {**cfg.voice_settings.model_dump(), "speed": voice_speed},
    }
    chars_texto = len(re.sub(r'<[^>]+>', '', texto_tts))
    for intento in range(1, 4):
        try:
            r = requests.post(url, json=payload, headers=headers, timeout=60)
            if r.status_code == 200:
                ruta_salida.write_bytes(r.content)
                if hasattr(_job_ctx, 'chars_usados'):
                    _job_ctx.chars_usados += chars_texto
                return True
        except Exception:
            pass
        time.sleep(2 ** intento)
    return False

def _load_audio(ruta: Path, output_format: str) -> "AudioSegment":
    """Carga audio. Para PCM crudo (sin cabecera) envuelve los bytes en un WAV en memoria."""
    if output_format.startswith("pcm_"):
        import wave, io
        rate = int(output_format.split("_")[1])   # pcm_44100 → 44100
        raw  = ruta.read_bytes()
        buf  = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)      # 16-bit PCM
            wf.setframerate(rate)
            wf.writeframes(raw)
        buf.seek(0)
        return AudioSegment.from_wav(buf)
    return AudioSegment.from_file(ruta)


def _bytes_to_audiosegment(raw: bytes, output_format: str) -> "AudioSegment":
    """Convierte bytes crudos de la API (PCM o MP3) a AudioSegment."""
    if output_format.startswith("pcm_"):
        import wave
        rate = int(output_format.split("_")[1])
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(rate)
            wf.writeframes(raw)
        buf.seek(0)
        return AudioSegment.from_wav(buf)
    return AudioSegment.from_file(io.BytesIO(raw))


def _trim_calentamiento(audio: "AudioSegment") -> "AudioSegment":
    """
    Elimina del inicio del audio el texto de calentamiento.
    Busca el primer silencio >= 800 ms después de los primeros 3000 ms.
    min_silence_len=800 ignora pausas naturales del habla (<500ms) y solo
    detecta el break explícito (1.5s) que se inserta tras la oración de calentamiento.
    """
    min_start_ms = 3000
    silencios = detect_silence(
        audio[min_start_ms:],
        min_silence_len=800,
        silence_thresh=-38,
    )
    if silencios:
        s_ini, s_fin = silencios[0]
        corte = min_start_ms + (s_ini + s_fin) // 2
        recortado = audio[corte:]
        return recortado if len(recortado) > 200 else audio
    return audio


def cargar_oracion(texto: str, carpeta: Path, prefijo: str, indice: int,
                   voice_speed: float, cfg: Config,
                   force_regen: bool = False) -> Optional["AudioSegment"]:
    settings_dict = cfg.voice_settings.model_dump()
    fmt = getattr(cfg, "output_format", "mp3_44100_128") or "mp3_44100_128"
    ruta = ruta_cache(carpeta, prefijo, indice, texto, voice_speed, settings_dict, fmt)
    if force_regen and ruta.exists():
        ruta.unlink()
    if not ruta.exists():
        usar_warmup = (
            cfg.usar_calentamiento
            and prefijo in ("intro", "medit")
        )
        if usar_warmup:
            warmup_text = _warmup_intro_medit(cfg)
            calentamiento_con_break = re.sub(r'\s*$', ' <break time="2.0s"/>', warmup_text)
            texto_api = calentamiento_con_break + "\n\n" + texto
            tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
            tmp.close()
            tmp_path = Path(tmp.name)
            try:
                ok = texto_a_audio_api(texto_api, tmp_path, voice_speed, cfg)
                if not ok:
                    return None
                audio_raw = _load_audio(tmp_path, fmt)
                audio_trimmed = _trim_calentamiento(audio_raw)
                audio_trimmed.export(str(ruta), format="wav")
            finally:
                tmp_path.unlink(missing_ok=True)
        else:
            ok = texto_a_audio_api(texto, ruta, voice_speed, cfg)
            if not ok:
                return None
    audio = _load_audio(ruta, fmt)
    if cfg.extend_silence:
        audio = extender_silencios_internos(audio, cfg)
    return audio

def detectar_secciones(texto: str) -> dict:
    texto = texto.strip()
    pi = re.search(r'\[INTRO\](.*?)(?=\[AFIRMACIONES\]|\[MEDITACION\]|$)', texto, re.S | re.I)
    pa = re.search(r'\[AFIRMACIONES\](.*?)(?=\[MEDITACION\]|$)', texto, re.S | re.I)
    pm = re.search(r'\[MEDITACION\](.*)', texto, re.S | re.I)
    if pi or pa or pm:
        return {
            "intro": pi.group(1).strip() if pi else "",
            "afirmaciones": pa.group(1).strip() if pa else "",
            "meditacion": pm.group(1).strip() if pm else ""
        }
    for sep in ["---", "==="]:
        partes = texto.split(sep, 1)
        if len(partes) == 2:
            return {"intro": partes[0].strip(), "afirmaciones": partes[1].strip(), "meditacion": ""}
    lineas = [l.strip() for l in texto.splitlines() if l.strip()]
    intro, afirm, en_afirm = [], [], False
    for linea in lineas:
        if len(linea.split()) <= 20:
            en_afirm = True
        (afirm if en_afirm else intro).append(linea)
    if not intro:
        return {"intro": "", "afirmaciones": "\n".join(afirm), "meditacion": ""}
    return {"intro": " ".join(intro), "afirmaciones": "\n".join(afirm), "meditacion": ""}

def emit_event(job_id: str, event_type: str, data: dict):
    job_events[job_id].append({"type": event_type, "data": data})
    if job_id in jobs:
        jobs[job_id]["last_event"] = {"type": event_type, "data": data}


# ── Classifier integration helpers ────────────────────────────────────────────

_SEG_MAP_CLS = {"intro": "intro", "afirm": "afirmaciones", "medit": "meditacion"}
_DEC_MAP_CLS = {
    "ok": "aprobado", "aprobado": "aprobado",
    "regenerate": "rechazado", "rechazado": "rechazado",
    "skip": "rechazado",
}


def _clasificar_en_bg(
    job_id: str, section: str, index: int,
    ruta_preview: str, texto: str, params_elevenlabs: dict,
):
    """
    Spawn a background thread that:
    1. Extracts audio features from the preview WAV.
    2. Runs the classifier (if user has enough examples).
    3. Emits a `*_classified` SSE event with the result.
    """
    if not CLASSIFIER_AVAILABLE:
        return

    def _task():
        job_meta      = jobs.get(job_id, {})
        user_id       = job_meta.get("user_id")
        # Classifier disabled: user_id is None when classifier_enabled=false on frontend
        if not user_id:
            return
        language_code = job_meta.get("language_code", "es")
        segmento      = _SEG_MAP_CLS.get(section, section)

        def _on_features(features):
            # Phase 1: Early discard — bad pronunciation detected by WhisperX
            if features.get("descartar_automatico"):
                # Track attempt count per segment to prevent infinite auto-regen loops
                job_data   = jobs.get(job_id, {})
                auto_counts = job_data.setdefault("auto_regen_counts", {})
                regen_key  = f"{section}_{index}"
                attempt    = auto_counts.get(regen_key, 0) + 1
                auto_counts[regen_key] = attempt

                coincid = features.get("coincidencia_texto")

                if attempt <= 2:
                    if user_id:
                        guardar_ejemplo(
                            user_id, segmento, features, "rechazado",
                            intento=attempt,
                            params_elevenlabs=features.get("params_elevenlabs") or {},
                            language_code=language_code,
                            razon_rechazo=["mala_pronunciacion"],
                        )
                        verificar_y_regenerar_resumen(user_id, segmento, language_code)
                    emit_event(job_id, f"{section}_auto_rejected", {
                        "index":              index,
                        "section":            section,
                        "razon":              features.get("razon_descarte", "mala_pronunciacion"),
                        "coincidencia_texto": coincid,
                        "intento":            attempt,
                    })
                else:
                    # Max auto-regen attempts reached — notify for manual review, no more auto-regen
                    emit_event(job_id, f"{section}_discard_warning", {
                        "index":              index,
                        "section":            section,
                        "razon":              features.get("razon_descarte", "mala_pronunciacion"),
                        "coincidencia_texto": coincid,
                        "message":            f"Pronunciación incorrecta ({coincid}% coincidencia). Revisión manual recomendada.",
                    })
                return

            if not user_id:
                return
            umbral = obtener_umbral(user_id, segmento, language_code)
            if umbral == "sin_datos":
                return
            resultado = clasificar_audio(user_id, segmento, features, texto, language_code)
            if resultado.get("decision") is not None:
                emit_event(job_id, f"{section}_classified", {
                    "index":                index,
                    "section":              section,
                    "confianza":            resultado.get("confianza"),
                    "decision":             resultado.get("decision"),
                    "razon":                resultado.get("razon_principal"),
                    "razon_principal":      resultado.get("razon_principal"),
                    "explicacion_detallada": resultado.get("explicacion_detallada"),
                    "modo":                 resultado.get("modo"),
                })

        cachear_features_async(
            job_id, section, index, ruta_preview,
            texto, params_elevenlabs, _on_features,
        )

    threading.Thread(target=_task, daemon=True).start()


def _guardar_decision_clasificador(
    job_id: str, user_id: int, section: str, index: int, decision_str: str,
    calidad_score: int = None, razon_rechazo: list = None,
):
    """
    Save a user's review decision as a classifier training example.
    Runs in a FastAPI BackgroundTask — never blocks the HTTP response.
    """
    if not CLASSIFIER_AVAILABLE or not user_id:
        return
    try:
        language_code = jobs.get(job_id, {}).get("language_code", "es")
        segmento = _SEG_MAP_CLS.get(section, section)
        decision = _DEC_MAP_CLS.get(decision_str, "rechazado")
        features = get_cached_features(job_id, section, index)
        if not features:
            return
        guardar_ejemplo(
            user_id, segmento, features, decision,
            intento=1,
            params_elevenlabs=features.get("params_elevenlabs") or {},
            language_code=language_code,
            calidad_score=calidad_score,
            razon_rechazo=razon_rechazo,
        )
        verificar_y_regenerar_resumen(user_id, segmento, language_code)
    except Exception as exc:
        print(f"[guiones] _guardar_decision_clasificador error: {exc}")

def _construir_bloques(texto: str, cfg: Config,
                       warmup_overhead: int = 0) -> list[str]:
    """
    Utilidad interna: divide texto en bloques respetando min/max chars.
    warmup_overhead: chars del warmup + break ya calculados por la sección
    que llama (_bloques_intro, _bloques_medit). No llamar directamente
    desde el loop de generación; usar las funciones de sección.
    """
    max_chars = cfg.max_chars_parrafo - warmup_overhead
    min_chars = cfg.min_chars_parrafo

    lineas = [l.strip() for l in texto.splitlines() if l.strip()]

    fusionados: list[str] = []
    buffer = ""
    for linea in lineas:
        if not buffer:
            buffer = linea
        else:
            if len(buffer) < min_chars:
                candidato = buffer + "\n\n" + linea
                if len(candidato) <= max_chars:
                    buffer = candidato
                else:
                    fusionados.append(buffer)
                    buffer = linea
            else:
                fusionados.append(buffer)
                buffer = linea
    if buffer:
        if (fusionados
                and len(buffer) < min_chars
                and len(fusionados[-1]) + 2 + len(buffer) <= max_chars):
            fusionados[-1] = fusionados[-1] + "\n\n" + buffer
        else:
            fusionados.append(buffer)

    # --- NUEVA LÓGICA: División por pausas menores para evitar sobrepasar límites ---
    def _dividir_por_comas(texto_largo: str) -> list[str]:
        """
        Divide un texto excepcionalmente largo buscando pausas menores (comas, 
        punto y coma, dos puntos) o, en el peor caso, por espacios (palabras).
        """
        if len(texto_largo) <= max_chars:
            return [texto_largo]

        # 1. Intentar dividir por pausas menores (, ; :) seguidas de espacio
        partes = re.split(r'(?<=[,;:])\s+', texto_largo)
        
        # Si no hubo comas, forzamos división por palabras (espacios puros)
        if len(partes) <= 1:
            palabras = texto_largo.split(' ')
            ensamblados = []
            temp = ""
            for p in palabras:
                if len(temp) + len(p) + 1 <= max_chars:
                    temp += (" " if temp else "") + p
                else:
                    if temp: ensamblados.append(temp)
                    temp = p
            if temp: ensamblados.append(temp)
            return ensamblados

        # 2. Ensamblar las partes divididas por comas respetando max_chars
        ensamblados = []
        temp = ""
        for p in partes:
            # Si una sub-parte (entre comas) sigue siendo gigantesca, recursividad
            if len(p) > max_chars:
                if temp:
                    ensamblados.append(temp)
                    temp = ""
                ensamblados.extend(_dividir_por_comas(p))
            elif len(temp) + len(p) + 1 <= max_chars:
                temp += (" " if temp else "") + p
            else:
                if temp: ensamblados.append(temp)
                temp = p
        if temp:
            ensamblados.append(temp)
        
        return ensamblados
    # ---------------------------------------------------------------------------------

    bloques: list[str] = []
    for bloque in fusionados:
        if len(bloque) <= max_chars:
            bloques.append(bloque)
        else:
            # División primaria por puntos
            oraciones = re.split(r'(?<=[.!?])\s+', bloque)
            bloque_actual = ""
            for oracion in oraciones:
                # Chequeo normal: ¿Cabe en el bloque actual?
                if len(bloque_actual) + len(oracion) + 2 <= max_chars:
                    bloque_actual += ("\n\n" if bloque_actual else "") + oracion
                else:
                    if bloque_actual:
                        bloques.append(bloque_actual)
                    
                    # --- FIX APLICADO AQUÍ ---
                    # Si la oración por sí sola excede el max_chars (ej. párrafos sin puntos)
                    if len(oracion) > max_chars:
                        sub_oraciones = _dividir_por_comas(oracion)
                        # Añadimos todas menos la última al array final
                        for sub_o in sub_oraciones[:-1]:
                            bloques.append(sub_o)
                        # La última queda como 'bloque_actual' para seguir concatenando si es posible
                        bloque_actual = sub_oraciones[-1] if sub_oraciones else ""
                    else:
                        bloque_actual = oracion
                    # -------------------------
            if bloque_actual:
                bloques.append(bloque_actual)

    return bloques

def _parsear_afirmaciones(texto: str) -> list[str]:
    """Devuelve las afirmaciones como lista de líneas individuales."""
    return [l.strip() for l in texto.splitlines() if l.strip()]


def _construir_bloques_afirm(texto: str, cfg: Config) -> tuple[list[str], list[list[str]]]:
    """
    Para afirmaciones: fusiona líneas cortas respetando min/max chars.
    Las afirmaciones se unen con "\\n\\n" (sin breaks SSML); los puntos de
    corte exactos se obtienen mediante el endpoint /with-timestamps de
    ElevenLabs en lugar de detectar silencios.

    Returns:
        bloques_texto  : list[str]        — texto fusionado para TTS
        lineas_x_bloque: list[list[str]]  — líneas originales de cada bloque
                                            (para dividir el audio después)
    """
    max_chars = cfg.max_chars_parrafo
    min_chars = cfg.min_chars_parrafo
    sep = "\n\n"

    lineas = [l.strip() for l in texto.splitlines() if l.strip()]

    grupos_t: list[str]        = []   # texto TTS de cada grupo
    grupos_l: list[list[str]]  = []   # líneas originales de cada grupo

    buf_t = ""
    buf_l: list[str] = []

    for linea in lineas:
        if not buf_t:
            buf_t = linea
            buf_l = [linea]
        elif len(buf_t) < min_chars:
            candidato = buf_t + sep + linea
            if len(candidato) <= max_chars:
                buf_t = candidato
                buf_l.append(linea)
            else:
                grupos_t.append(buf_t);  grupos_l.append(buf_l)
                buf_t = linea;           buf_l = [linea]
        else:
            grupos_t.append(buf_t);  grupos_l.append(buf_l)
            buf_t = linea;           buf_l = [linea]

    if buf_l:
        if (grupos_t
                and len(buf_t) < min_chars
                and len(grupos_t[-1]) + len(sep) + len(buf_t) <= max_chars):
            grupos_t[-1] = grupos_t[-1] + sep + buf_t
            grupos_l[-1].extend(buf_l)
        else:
            grupos_t.append(buf_t);  grupos_l.append(buf_l)

    # Resolver grupos que superen max_chars: dividir línea a línea
    bloques_t: list[str]       = []
    bloques_l: list[list[str]] = []
    for g_t, g_l in zip(grupos_t, grupos_l):
        if len(g_t) <= max_chars:
            bloques_t.append(g_t);  bloques_l.append(g_l)
        else:
            for linea in g_l:
                bloques_t.append(linea);  bloques_l.append([linea])

    return bloques_t, bloques_l


def _trim_silence(
    seg: "AudioSegment",
    thresh_db: int = -38,
    chunk_ms: int = 10,
    keep_ms: int = 150,
) -> "AudioSegment":
    """
    Elimina el silencio al inicio y al final del segmento.
    Conserva `keep_ms` ms de silencio en cada extremo para que la reproducción
    no empiece/termine de golpe.
    """
    dur = len(seg)
    start = max(0, detect_leading_silence(seg,         silence_threshold=thresh_db, chunk_size=chunk_ms) - keep_ms)
    end   = max(0, detect_leading_silence(seg.reverse(), silence_threshold=thresh_db, chunk_size=chunk_ms) - keep_ms)
    trimmed = seg[start: dur - end]
    return trimmed if len(trimmed) > 200 else seg   # fallback si quedó vacío



# =============================================================
#  AFIRMACIONES: TIMESTAMPS API
# =============================================================

def _cargar_grupo_afirm_timestamps(
    texto_grupo: str,
    carpeta: Path,
    indice: int,
    voice_speed: float,
    cfg: Config,
    force_regen: bool = False,
) -> tuple[Optional["AudioSegment"], list[str], list[float], list[float]]:
    # ⬇️ NOTA: Ahora devolvemos 4 elementos (se añade char_start_ms)

    settings_dict = cfg.voice_settings.model_dump()
    api_fmt = cfg.output_format

    # Reemplazamos los saltos de línea por puntos suspensivos para forzar el silencio en el TTS
    texto_tts = texto_grupo.strip().replace("\n\n", "\n\n...\n\n")

    h = hash_texto(texto_tts, voice_speed, settings_dict, api_fmt + "_ts")
    ruta_wav  = carpeta / f"afirm_grp_{indice:05d}_{h}.wav"
    ruta_json = carpeta / f"afirm_grp_{indice:05d}_{h}_align.json"

    if force_regen:
        ruta_wav.unlink(missing_ok=True)
        ruta_json.unlink(missing_ok=True)

    # Cargar de caché
    if ruta_wav.exists() and ruta_json.exists():
        try:
            audio = AudioSegment.from_file(str(ruta_wav))
            align = json.loads(ruta_json.read_text())
            return audio, align["characters"], align["char_start_ms"], align["char_end_ms"]
        except Exception:
            pass  # caché corrupta → regenerar

    url = (f"https://api.elevenlabs.io/v1/text-to-speech/"
           f"{cfg.voice_id}/with-timestamps?output_format={api_fmt}")
    headers = {"xi-api-key": cfg.api_key, "Content-Type": "application/json"}
    payload = {
        "text": texto_tts, # Enviamos el texto con los ...
        "model_id": cfg.model_id,
        "language_code": cfg.language_code,
        "voice_settings": {**cfg.voice_settings.model_dump(), "speed": voice_speed},
    }

    for intento in range(1, 4):
        try:
            r = requests.post(url, json=payload, headers=headers, timeout=60)
            if r.status_code == 200:
                data = r.json()
                audio_bytes = base64.b64decode(data["audio_base64"])
                audio = _bytes_to_audiosegment(audio_bytes, api_fmt)
                alignment = data.get("alignment", {})
                characters = alignment.get("characters", [])

                # Extraemos ambos tiempos
                char_start_ms = [t * 1000.0 for t in alignment.get("character_start_times_seconds", [])]
                char_end_ms   = [t * 1000.0 for t in alignment.get("character_end_times_seconds", [])]
                
                audio.export(str(ruta_wav), format="wav")
                ruta_json.write_text(json.dumps(
                    {"characters": characters, "char_start_ms": char_start_ms, "char_end_ms": char_end_ms}
                ))
                if hasattr(_job_ctx, 'chars_usados'):
                    _job_ctx.chars_usados += len(texto_grupo.strip())
                return audio, characters, char_start_ms, char_end_ms
        except Exception:
            pass
        time.sleep(2 ** intento)

    return None, [], [], []

def _normalizar_palabra(w: str) -> str:
    """Minúsculas sin acentos ni puntuación — para matching tolerante."""
    import unicodedata
    w = unicodedata.normalize("NFKD", w)
    w = "".join(c for c in w if not unicodedata.combining(c))
    return re.sub(r"[^\w]", "", w.lower())


def _cortar_con_whisper(
    audio: "AudioSegment",
    lineas: list[str],
) -> list["AudioSegment"]:
    """
    Divide el audio de un grupo de afirmaciones usando Whisper con
    word_timestamps=True.  Escucha el audio real, por lo que no depende
    de la consistencia de ElevenLabs en silencios ni de matching de texto exacto.

    Flujo:
      1. Exporta el audio a WAV temporal.
      2. Transcribe con Whisper (modelo ya cargado para calibración).
      3. Para cada afirmación (excepto la última) busca su última palabra
         en la secuencia de palabras detectadas y corta justo después.
      4. Si Whisper no está disponible o falla, hace un fallback proporcional.
    """
    if len(lineas) <= 1:
        return [audio]

    # ── Fallback proporcional ────────────────────────────────────────────────
    def _fallback_proporcional():
        dur  = len(audio)
        total = sum(len(l) for l in lineas)
        segs, prev = [], 0
        acum = 0
        for linea in lineas[:-1]:
            acum += len(linea)
            cut = int(dur * acum / total)
            segs.append(audio[prev:cut])
            prev = cut
        segs.append(audio[prev:])
        return segs

    if not WHISPER_AVAILABLE:
        return _fallback_proporcional()

    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            tmp_path = f.name
        audio.export(tmp_path, format="wav")

        model  = _get_whisper_model()
        result = model.transcribe(
            tmp_path,
            word_timestamps=True,
            language=None,   # detección automática
            fp16=False,
        )
    except Exception:
        return _fallback_proporcional()
    finally:
        if tmp_path:
            Path(tmp_path).unlink(missing_ok=True)

    # Extraer lista plana de palabras con timestamps
    words: list[dict] = []
    for seg in result.get("segments", []):
        for w in seg.get("words", []):
            words.append({
                "word":     _normalizar_palabra(w.get("word", "")),
                "end_ms":   int(w.get("end", 0) * 1000),
            })

    if not words:
        return _fallback_proporcional()

    # ── Cortar por las últimas palabras de cada afirmación ───────────────────
    # Buscar las últimas 2 palabras como secuencia para evitar falsos positivos
    # (una sola palabra puede aparecer antes de una coma dentro de la misma afirmación).
    segmentos: list["AudioSegment"] = []
    prev_ms  = 0
    word_idx = 0

    def _palabras_cola(linea: str, n: int = 2) -> list[str]:
        palabras = [_normalizar_palabra(p) for p in linea.split() if p.strip()]
        return palabras[-n:] if len(palabras) >= n else palabras

    def _coincide(w_transcrita: str, w_esperada: str) -> bool:
        return w_transcrita == w_esperada or (
            len(w_esperada) >= 4 and (w_esperada in w_transcrita or w_transcrita in w_esperada)
        )

    for linea in lineas[:-1]:
        cola = _palabras_cola(linea, n=2)   # últimas 2 palabras (o 1 si la afirmación es muy corta)
        if not cola:
            continue

        cut_ms = None

        # Intentar match de la secuencia completa de 'cola'
        n_cola = len(cola)
        for i in range(word_idx, len(words) - n_cola + 1):
            if all(_coincide(words[i + j]["word"], cola[j]) for j in range(n_cola)):
                cut_ms   = min(words[i + n_cola - 1]["end_ms"] + 150, len(audio))
                word_idx = i + n_cola
                break

        # Si no encontró la secuencia, intentar solo la última palabra
        if cut_ms is None:
            ultima = cola[-1]
            for i in range(word_idx, len(words)):
                if _coincide(words[i]["word"], ultima):
                    cut_ms   = min(words[i]["end_ms"] + 150, len(audio))
                    word_idx = i + 1
                    break

        if cut_ms is None:
            # Estimación proporcional como último recurso
            total_chars = sum(len(l) for l in lineas)
            done_chars  = sum(len(l) for l in lineas[:lineas.index(linea) + 1])
            cut_ms = min(int(len(audio) * done_chars / total_chars) + 150, len(audio))

        segmentos.append(audio[prev_ms:cut_ms])
        prev_ms = cut_ms

    segmentos.append(audio[prev_ms:])
    return segmentos


def _cortar_por_timestamps(
    audio: "AudioSegment",
    characters: list[str],
    char_start_ms: list[float],
    char_end_ms: list[float],
    lineas: list[str],
) -> list["AudioSegment"]:
    import unicodedata
    import re

    if len(lineas) <= 1:
        return [audio]

    if not char_end_ms or not char_start_ms:
        dur = len(audio)
        n   = len(lineas)
        return [audio[i * dur // n: (i + 1) * dur // n] for i in range(n)]

    def _limpiar(s: str) -> str:
        """Remueve todo excepto letras y números para un mapeo infalible."""
        s = unicodedata.normalize("NFC", s.lower())
        return re.sub(r'[^\w]', '', s)

    # 1. Crear un string limpio de los caracteres de ElevenLabs y un mapa de sus índices originales
    clean_chars = []
    char_to_orig_idx = []
    for i, c in enumerate(characters):
        cl = _limpiar(c)
        if cl:
            clean_chars.append(cl)
            char_to_orig_idx.append(i)

    clean_text = "".join(clean_chars)

    # 2. Encontrar el índice original de inicio y fin para cada afirmación
    segment_indices = []
    cursor = 0
    for linea in lineas:
        cl_linea = _limpiar(linea)
        if not cl_linea:
            segment_indices.append(None)
            continue

        pos = clean_text.find(cl_linea, cursor)
        if pos != -1:
            start_orig = char_to_orig_idx[pos]
            end_orig = char_to_orig_idx[pos + len(cl_linea) - 1]
            segment_indices.append((start_orig, end_orig))
            cursor = pos + len(cl_linea)
        else:
            segment_indices.append(None)

    # 3. Cortar el audio exactamente en la mitad de los silencios entre frases
    segmentos: list["AudioSegment"] = []
    prev_cut_ms = 0

    for i in range(len(lineas) - 1):
        curr_seg = segment_indices[i]
        next_seg = segment_indices[i + 1]

        if curr_seg and next_seg:
            _, end_curr = curr_seg
            start_next, _ = next_seg
            
            # Tiempos: Final de la palabra actual y el inicio de la palabra siguiente
            fin_ms = char_end_ms[end_curr]
            ini_ms = char_start_ms[start_next]

            # Cortamos justo en la mitad. Si hay anomalía y se solapan, dejamos un margen de 50ms
            if ini_ms > fin_ms:
                cut_ms = int((fin_ms + ini_ms) / 2)
            else:
                cut_ms = int(fin_ms) + 50
        else:
            # Fallback proporcional en caso extremo de que no se encuentre la línea
            total_chars = sum(len(l) for l in lineas)
            done_chars = sum(len(l) for l in lineas[:i + 1])
            cut_ms = int(len(audio) * done_chars / total_chars)

        cut_ms = min(cut_ms, len(audio))
        segmentos.append(audio[prev_cut_ms:cut_ms])
        prev_cut_ms = cut_ms

    # Agregar la última afirmación
    segmentos.append(audio[prev_cut_ms:])
    return segmentos

def _regenerar_afirm_individual(
    texto: str,
    voice_speed: float,
    cfg: Config,
) -> Optional["AudioSegment"]:
    """
    Regenera una afirmación individual usando /with-timestamps para obtener
    un corte exacto por posición de carácter.

    Si el calentamiento está activo se antepone al texto (sin break tags)
    y se usa el timestamp del último carácter del warmup para cortar.
    Esto evita depender de la detección de silencios o de break tags que
    ElevenLabs puede no interpretar de forma consistente.
    """
    usar_warmup = cfg.usar_calentamiento
    texto_afirm = texto.strip()
    warmup_text = _warmup_afirm_regen(cfg, texto_afirm) if usar_warmup else ""

    texto_completo = (warmup_text + "\n\n" + texto_afirm) if warmup_text else texto_afirm

    url = (f"https://api.elevenlabs.io/v1/text-to-speech/"
           f"{cfg.voice_id}/with-timestamps?output_format={cfg.output_format}")
    headers = {"xi-api-key": cfg.api_key, "Content-Type": "application/json"}
    payload = {
        "text": texto_completo,
        "model_id": cfg.model_id,
        "language_code": cfg.language_code,
        "voice_settings": {**cfg.voice_settings.model_dump(), "speed": voice_speed},
    }

    audio_raw: Optional["AudioSegment"] = None
    characters: list[str] = []
    char_end_ms: list[float] = []

    for intento in range(1, 4):
        try:
            r = requests.post(url, json=payload, headers=headers, timeout=60)
            if r.status_code == 200:
                data = r.json()
                audio_bytes = base64.b64decode(data["audio_base64"])
                audio_raw = _bytes_to_audiosegment(audio_bytes, cfg.output_format)
                alignment = data.get("alignment", {})
                characters = alignment.get("characters", [])
                char_end_ms = [t * 1000.0 for t in
                               alignment.get("character_end_times_seconds", [])]
                if hasattr(_job_ctx, 'chars_usados'):
                    _job_ctx.chars_usados += len(texto_completo)
                break
        except Exception:
            pass
        time.sleep(2 ** intento)

    if audio_raw is None:
        return None

    # Cortar el warmup usando el timestamp del último carácter del texto warmup
    if warmup_text and characters and char_end_ms:
        aligned_text = "".join(characters)
        # Buscar la afirmación en el texto alineado a partir de la posición
        # aproximada donde termina el warmup (tolerancia de 5 chars para el \n\n)
        search_from = max(0, len(warmup_text) - 5)
        pos = aligned_text.find(texto_afirm[:min(30, len(texto_afirm))], search_from)
        if pos > 0:
            # Cortar justo antes del primer carácter de la afirmación
            cut_ms = int(char_end_ms[pos - 1])
            audio_afirm = audio_raw[cut_ms:]
        else:
            # Fallback: tomar desde el punto medio del warmup estimado
            audio_afirm = audio_raw
    else:
        audio_afirm = audio_raw

    audio_afirm = _trim_silence(audio_afirm)
    if cfg.extend_silence:
        audio_afirm = extender_silencios_internos(audio_afirm, cfg)
    return audio_afirm


# =============================================================
#  HELPERS DE REVISIÓN
# =============================================================

def _guardar_preview(audio: "AudioSegment", job_id: str,
                     section: str, index: int) -> str:
    path = CARPETA_TEMP / f"preview_{job_id}_{section}_{index}.wav"
    audio.export(str(path), format="wav")
    return f"/api/preview/{job_id}/{section}/{index}?t={int(time.time())}"

def _esperar_revision(job_id: str, section: str, items: list[str],
                      carpeta: Path, prefijo: str,
                      voice_speed: float,
                      cfg: Config, event_ready: str,
                      event_regenerating: str,
                      audio_fn=None):
    """
    audio_fn: función de sección opcional (ej. _audio_intro, _audio_medit).
    Si se provee, se usa para regenerar en lugar de llamar cargar_oracion directamente.
    Firma esperada: audio_fn(texto, carpeta, indice, cfg, force_regen=True)
    """
    decision_key = f"{section}_decisions"
    lock_key     = f"{job_id}_{section}"

    review_event = threading.Event()
    job_locks[lock_key] = review_event

    while True:
        decisions = jobs[job_id].get(decision_key, {})
        pending   = [i for i in range(len(items)) if i not in decisions]

        if not pending:
            break

        review_event.wait(timeout=300)
        review_event.clear()

        for i in list(decisions.keys()):
            if decisions[i] == "regenerate":
                emit_event(job_id, event_regenerating, {
                    "index": i,
                    "section": section,
                    "message": f"Regenerando segmento {i + 1}..."
                })
                if audio_fn is not None:
                    audio = audio_fn(items[i], carpeta, i, cfg, force_regen=True)
                else:
                    audio = cargar_oracion(
                        items[i], carpeta, prefijo, i,
                        voice_speed, cfg,
                        force_regen=True
                    )
                if audio:
                    audio_url = _guardar_preview(audio, job_id, section, i)
                    del decisions[i]
                    emit_event(job_id, event_ready, {
                        "index": i,
                        "section": section,
                        "text": items[i],
                        "audio_url": audio_url,
                        "message": f"Segmento {i + 1} regenerado"
                    })
                    _clasificar_en_bg(job_id, section, i,
                        str(CARPETA_TEMP / f"preview_{job_id}_{section}_{i}.wav"),
                        items[i], {})

# =============================================================
#  JOB DE GENERACIÓN
# =============================================================

def run_generation_job(job_id: str, guion: str, cfg: Config, nombre: str):
    try:
        jobs[job_id]["status"] = "running"
        carpeta = CARPETA_TEMP / nombre
        carpeta.mkdir(parents=True, exist_ok=True)

        # Inicializar contador de caracteres para este hilo
        _job_ctx.chars_usados = 0

        secciones   = detectar_secciones(guion)
        tiene_intro = bool(secciones["intro"])
        tiene_afirm = bool(secciones["afirmaciones"])
        tiene_medit = bool(secciones.get("meditacion", ""))

        # Detección automática de idioma: sobrescribe language_code si el texto
        # detectado difiere del configurado (protección ante usuarios descuidados).
        idioma_detectado = _detectar_idioma(guion)
        if idioma_detectado and idioma_detectado != cfg.language_code:
            cfg.language_code = idioma_detectado
        jobs[job_id]["language_code"] = cfg.language_code

        emit_event(job_id, "start", {
            "tiene_intro":   tiene_intro,
            "tiene_afirm":   tiene_afirm,
            "tiene_medit":   tiene_medit,
            "language_code": cfg.language_code,
            "message": "Iniciando generación..."
        })

        # ── INTRO ─────────────────────────────────────────────
        bloques_intro = []
        if tiene_intro:
            bloques_intro = _bloques_intro(secciones["intro"], cfg)
            jobs[job_id]["intro_bloques"]   = bloques_intro
            jobs[job_id]["intro_decisions"] = {}

            emit_event(job_id, "intro_start", {
                "total": len(bloques_intro),
                "message": f"Generando {len(bloques_intro)} segmento(s) de intro..."
            })

            for i, bloque in enumerate(bloques_intro):
                emit_event(job_id, "intro_generating", {
                    "index": i, "total": len(bloques_intro),
                    "text": bloque[:80],
                    "message": f"Intro {i + 1}/{len(bloques_intro)}"
                })
                audio = _audio_intro(bloque, carpeta, i, cfg)
                if audio:
                    audio_url = _guardar_preview(audio, job_id, "intro", i)
                    emit_event(job_id, "intro_ready", {
                        "index": i, "section": "intro",
                        "text": bloque, "audio_url": audio_url,
                        "message": f"Segmento de intro {i + 1} listo"
                    })
                    _clasificar_en_bg(job_id, "intro", i,
                        str(CARPETA_TEMP / f"preview_{job_id}_intro_{i}.wav"),
                        bloque,
                        {"speed": cfg.intro_voice_speed,
                         "stability": cfg.voice_settings.stability,
                         "similarity_boost": cfg.voice_settings.similarity_boost})

            emit_event(job_id, "intro_review_start", {
                "message": "Intro generada. Esperando revisión...",
                "total": len(bloques_intro)
            })
            jobs[job_id]["status"] = "awaiting_review"

            _esperar_revision(
                job_id, "intro", bloques_intro, carpeta, "intro",
                cfg.intro_voice_speed, cfg,
                event_ready="intro_ready", event_regenerating="intro_regenerating",
                audio_fn=_audio_intro
            )
            emit_event(job_id, "intro_review_done", {"message": "Revisión de intro completada"})

        # ── AFIRMACIONES ──────────────────────────────────────
        afirmaciones = []
        if tiene_afirm:
            afirm_grupos, afirm_lineas_x_grupo = _construir_bloques_afirm(
                secciones["afirmaciones"], cfg
            )
            afirmaciones = [l for lineas in afirm_lineas_x_grupo for l in lineas]
            jobs[job_id]["afirmaciones"]         = afirmaciones
            jobs[job_id]["afirm_grupos"]         = afirm_grupos
            jobs[job_id]["afirm_lineas_x_grupo"] = afirm_lineas_x_grupo
            jobs[job_id]["afirm_decisions"]      = {}

            emit_event(job_id, "afirm_start", {
                "total": len(afirmaciones),
                "message": f"Generando {len(afirmaciones)} afirmaciones..."
            })

            flat_idx = 0
            for i, (grupo_texto, grupo_lineas) in enumerate(
                zip(afirm_grupos, afirm_lineas_x_grupo)
            ):
                n_en_grupo = len(grupo_lineas)
                emit_event(job_id, "afirm_generating", {
                    "index": flat_idx, "total": len(afirmaciones),
                    "text": grupo_lineas[0][:80],
                    "message": f"Afirmación {flat_idx + 1}/{len(afirmaciones)}"
                })

                audio_grp, characters, char_start_ms, char_end_ms = _cargar_grupo_afirm_timestamps(
                    grupo_texto, carpeta, i, cfg.afirm_voice_speed, cfg
                )

                if audio_grp and n_en_grupo > 1:
                    raw_segs = _cortar_por_timestamps(audio_grp, characters, char_start_ms, char_end_ms, grupo_lineas)
                elif audio_grp:
                    raw_segs = [audio_grp]
                else:
                    raw_segs = [None] * n_en_grupo

                segmentos = []
                for seg in raw_segs:
                    if seg is None:
                        segmentos.append(None)
                        continue
                    seg = _trim_silence(seg)
                    if cfg.extend_silence:
                        seg = extender_silencios_internos(seg, cfg)
                    segmentos.append(seg)

                for linea, seg in zip(grupo_lineas, segmentos):
                    if seg is not None:
                        audio_url = _guardar_preview(seg, job_id, "afirm", flat_idx)
                        emit_event(job_id, "afirm_ready", {
                            "index": flat_idx, "section": "afirm",
                            "text": linea, "audio_url": audio_url,
                            "message": f"Afirmación {flat_idx + 1} lista"
                        })
                        _clasificar_en_bg(job_id, "afirm", flat_idx,
                            str(CARPETA_TEMP / f"preview_{job_id}_afirm_{flat_idx}.wav"),
                            linea,
                            {"speed": cfg.afirm_voice_speed,
                             "stability": cfg.voice_settings.stability,
                             "similarity_boost": cfg.voice_settings.similarity_boost})
                    flat_idx += 1

            emit_event(job_id, "afirm_review_start", {
                "message": "Afirmaciones generadas. Esperando revisión...",
                "total": len(afirmaciones)
            })
            jobs[job_id]["status"] = "awaiting_review"

            # Loop de revisión custom: respeta el agrupamiento min/max al regenerar
            _review_event_afirm = threading.Event()
            job_locks[f"{job_id}_afirm"] = _review_event_afirm

            while True:
                decisions = jobs[job_id].get("afirm_decisions", {})
                pending = [i for i in range(len(afirmaciones)) if i not in decisions]
                if not pending:
                    break
                _review_event_afirm.wait(timeout=300)
                _review_event_afirm.clear()

                for flat_i in list(decisions.keys()):
                    if decisions[flat_i] != "regenerate":
                        continue
                    emit_event(job_id, "afirm_regenerating", {
                        "index": flat_i, "section": "afirm",
                        "message": f"Regenerando afirmación {flat_i + 1}..."
                    })
                    texto_afirm = afirmaciones[flat_i]

                    # Regeneración individual con filler (warmup) para garantizar
                    # corte limpio en silencio explícito, independiente del grupo.
                    audio = _regenerar_afirm_individual(
                        texto_afirm, cfg.afirm_voice_speed, cfg
                    )
                    if audio:
                        audio_url = _guardar_preview(audio, job_id, "afirm", flat_i)
                        del decisions[flat_i]
                        emit_event(job_id, "afirm_ready", {
                            "index": flat_i, "section": "afirm",
                            "text": texto_afirm, "audio_url": audio_url,
                            "message": f"Afirmación {flat_i + 1} regenerada"
                        })
                        _clasificar_en_bg(job_id, "afirm", flat_i,
                            str(CARPETA_TEMP / f"preview_{job_id}_afirm_{flat_i}.wav"),
                            texto_afirm,
                            {"speed": cfg.afirm_voice_speed,
                             "stability": cfg.voice_settings.stability,
                             "similarity_boost": cfg.voice_settings.similarity_boost})

            emit_event(job_id, "afirm_review_done", {"message": "Revisión de afirmaciones completada"})

        # ── MEDITACIÓN ────────────────────────────────────────
        bloques_medit = []
        if tiene_medit:
            bloques_medit = _bloques_medit(secciones["meditacion"], cfg)
            jobs[job_id]["medit_bloques"]   = bloques_medit
            jobs[job_id]["medit_decisions"] = {}

            emit_event(job_id, "medit_start", {
                "total": len(bloques_medit),
                "message": f"Generando {len(bloques_medit)} segmento(s) de meditación..."
            })

            for i, bloque in enumerate(bloques_medit):
                emit_event(job_id, "medit_generating", {
                    "index": i, "total": len(bloques_medit),
                    "text": bloque[:80],
                    "message": f"Meditación {i + 1}/{len(bloques_medit)}"
                })
                audio = _audio_medit(bloque, carpeta, i, cfg)
                if audio:
                    audio_url = _guardar_preview(audio, job_id, "medit", i)
                    emit_event(job_id, "medit_ready", {
                        "index": i, "section": "medit",
                        "text": bloque, "audio_url": audio_url,
                        "message": f"Segmento de meditación {i + 1} listo"
                    })
                    _clasificar_en_bg(job_id, "medit", i,
                        str(CARPETA_TEMP / f"preview_{job_id}_medit_{i}.wav"),
                        bloque,
                        {"speed": cfg.medit_voice_speed,
                         "stability": cfg.voice_settings.stability,
                         "similarity_boost": cfg.voice_settings.similarity_boost})

            emit_event(job_id, "medit_review_start", {
                "message": "Meditación generada. Esperando revisión...",
                "total": len(bloques_medit)
            })
            jobs[job_id]["status"] = "awaiting_review"

            _esperar_revision(
                job_id, "medit", bloques_medit, carpeta, "medit",
                cfg.medit_voice_speed, cfg,
                event_ready="medit_ready", event_regenerating="medit_regenerating",
                audio_fn=_audio_medit
            )
            emit_event(job_id, "medit_review_done", {"message": "Revisión de meditación completada"})

        # ── ENSAMBLAR ─────────────────────────────────────────
        emit_event(job_id, "building", {"message": "Ensamblando audio final..."})
        jobs[job_id]["status"] = "building"
        audio_final = AudioSegment.empty()

        if tiene_intro:
            intro_decisions = jobs[job_id].get("intro_decisions", {})
            audio_intro = AudioSegment.empty()
            last_included = -1
            for i, bloque in enumerate(bloques_intro):
                if intro_decisions.get(i) == "skip":
                    continue
                path = CARPETA_TEMP / f"preview_{job_id}_intro_{i}.wav"
                if path.exists():
                    seg = AudioSegment.from_file(str(path))
                    if last_included >= 0:
                        audio_intro += silencio(cfg.pausa_entre_oraciones)
                    audio_intro  += seg
                    last_included = i
            audio_final += audio_intro
            if tiene_afirm and len(audio_intro) > 0:
                audio_final += silencio(cfg.pausa_intro_a_afirm)

        if tiene_afirm:
            afirm_decisions = jobs[job_id].get("afirm_decisions", {})
            audio_afirm = AudioSegment.empty()
            last_included = -1
            for i, _ in enumerate(afirmaciones):
                if afirm_decisions.get(i) == "skip":
                    continue
                path = CARPETA_TEMP / f"preview_{job_id}_afirm_{i}.wav"
                if path.exists():
                    seg = AudioSegment.from_file(str(path))
                    if last_included >= 0:
                        audio_afirm += silencio(cfg.pausa_entre_afirmaciones)
                    audio_afirm   += seg
                    last_included  = i
            audio_final += audio_afirm
            if tiene_medit and len(audio_afirm) > 0:
                audio_final += silencio(cfg.pausa_afirm_a_medit)

        if tiene_medit:
            medit_decisions = jobs[job_id].get("medit_decisions", {})
            audio_medit = AudioSegment.empty()
            last_included = -1
            for i, bloque in enumerate(bloques_medit):
                if medit_decisions.get(i) == "skip":
                    continue
                path = CARPETA_TEMP / f"preview_{job_id}_medit_{i}.wav"
                if path.exists():
                    seg = AudioSegment.from_file(str(path))
                    if last_included >= 0:
                        audio_medit += silencio(cfg.pausa_entre_meditaciones)
                    audio_medit   += seg
                    last_included  = i
            audio_final += audio_medit

        if len(audio_final) == 0:
            emit_event(job_id, "error", {"message": "Audio vacío. Verifica API key y guion."})
            jobs[job_id]["status"] = "error"
            return

        ruta_salida = CARPETA_SALIDA / f"{nombre}.wav"
        audio_final.export(str(ruta_salida), format="wav")
        mins = len(audio_final) / 60_000

        # Créditos: suma acumulada de chars enviados + consulta final para restantes
        chars_usados = getattr(_job_ctx, 'chars_usados', 0)
        subscription_final = _get_subscription_info(cfg.api_key)
        chars_restantes = subscription_final.get("character_limit", 0) \
                        - subscription_final.get("character_count", 0)

        jobs[job_id]["status"]        = "done"
        jobs[job_id]["output_file"]   = str(ruta_salida)
        jobs[job_id]["duration_mins"] = round(mins, 1)

        emit_event(job_id, "done", {
            "message": f"Audio generado: {mins:.1f} min",
            "download_url": f"/api/download/{job_id}",
            "duration_mins": round(mins, 1),
            "chars_usados":    chars_usados,
            "chars_restantes": chars_restantes,
            "chars_limite":    subscription_final.get("character_limit", 0),
        })

    except Exception as e:
        jobs[job_id]["status"] = "error"
        emit_event(job_id, "error", {"message": str(e)})

# =============================================================
#  ENDPOINTS
# =============================================================

@router.post("/generate")
def start_generation(req: GenerateRequest, background_tasks: BackgroundTasks):
    if not PYDUB_AVAILABLE:
        raise HTTPException(500, "pydub no instalado. Ejecuta: pip install pydub audioop-lts")

    job_id = str(uuid.uuid4())[:8]
    jobs[job_id] = {
        "id": job_id, "status": "queued",
        "nombre": req.nombre, "config": req.config.model_dump(),
        "user_id": req.user_id,
        "created_at": time.time(),
    }
    job_events[job_id] = []

    background_tasks.add_task(run_generation_job, job_id, req.guion, req.config, req.nombre)
    return {"job_id": job_id}


@router.get("/events/{job_id}")
def stream_events(job_id: str):
    if job_id not in jobs:
        raise HTTPException(404, "Job no encontrado")

    def event_generator():
        last_sent = 0
        while True:
            events     = job_events.get(job_id, [])
            new_events = events[last_sent:]
            for evt in new_events:
                yield f"data: {json.dumps(evt)}\n\n"
                last_sent += 1
            status = jobs.get(job_id, {}).get("status", "")
            if status in ("done", "error"):
                break
            time.sleep(0.4)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    )


@router.get("/job/{job_id}")
def get_job(job_id: str):
    if job_id not in jobs:
        raise HTTPException(404, "Job no encontrado")
    return dict(jobs[job_id])


@router.get("/preview/{job_id}/{section}/{index}")
def get_preview(job_id: str, section: str, index: int):
    path = CARPETA_TEMP / f"preview_{job_id}_{section}_{index}.wav"
    if not path.exists():
        raise HTTPException(404, "Preview no disponible")
    return FileResponse(str(path), media_type="audio/wav")


@router.post("/review")
def submit_review(decision: ReviewDecision, background_tasks: BackgroundTasks):
    job_id  = decision.job_id
    section = decision.section
    index   = decision.index

    if job_id not in jobs:
        raise HTTPException(404, "Job no encontrado")

    decision_key = f"{section}_decisions"
    if decision_key not in jobs[job_id]:
        jobs[job_id][decision_key] = {}

    if decision.new_text and decision.new_text.strip():
        array_key = {"intro": "intro_bloques", "afirm": "afirmaciones", "medit": "medit_bloques"}.get(section, "afirmaciones")
        if array_key in jobs[job_id] and index < len(jobs[job_id][array_key]):
            jobs[job_id][array_key][index] = decision.new_text.strip()

    jobs[job_id][decision_key][index] = decision.decision

    lock_key = f"{job_id}_{section}"
    if lock_key in job_locks:
        job_locks[lock_key].set()

    # Save training example for the classifier (background — never blocks response)
    user_id = jobs[job_id].get("user_id")
    if user_id:
        background_tasks.add_task(
            _guardar_decision_clasificador,
            job_id, user_id, section, index, decision.decision,
            decision.calidad_score, decision.razon_rechazo,
        )

    return {"ok": True}


@router.post("/finalize/{job_id}/{section}")
def finalize_section(job_id: str, section: str):
    if job_id not in jobs:
        raise HTTPException(404, "Job no encontrado")
    lock_key = f"{job_id}_{section}"
    if lock_key in job_locks:
        job_locks[lock_key].set()
    return {"ok": True}


_FORMAT_MEDIA = {
    "wav":  "audio/wav",
    "mp3":  "audio/mpeg",
    "flac": "audio/flac",
    "ogg":  "audio/ogg",
}

@router.get("/download/{job_id}")
def download(job_id: str, format: str = "wav", bitrate: str = "192k"):
    if job_id not in jobs:
        raise HTTPException(404, "Job no encontrado")
    output = jobs[job_id].get("output_file")
    if not output or not Path(output).exists():
        raise HTTPException(404, "Archivo no disponible aún")

    fmt    = format.lower() if format.lower() in _FORMAT_MEDIA else "wav"
    nombre = jobs[job_id].get("nombre", "meditacion")

    if fmt == "wav":
        return FileResponse(output, media_type="audio/wav", filename=f"{nombre}.wav")

    # Convertir al vuelo con pydub
    audio  = AudioSegment.from_file(output)
    buf    = tempfile.NamedTemporaryFile(suffix=f".{fmt}", delete=False)
    export_kwargs = {}
    if fmt == "mp3":
        export_kwargs["bitrate"] = bitrate
    audio.export(buf.name, format=fmt, **export_kwargs)
    buf.close()

    return FileResponse(
        buf.name,
        media_type=_FORMAT_MEDIA[fmt],
        filename=f"{nombre}.{fmt}",
        background=None,
    )


@router.get("/history")
def get_history():
    archivos = sorted(
        CARPETA_SALIDA.glob("*.wav"),
        key=lambda f: f.stat().st_mtime,
        reverse=True
    )
    return [
        {
            "name": f.stem,
            "filename": f.name,
            "size_mb": round(f.stat().st_size / 1_048_576, 2),
            "created_at": f.stat().st_mtime,
            "download_url": f"/api/history/download/{f.name}"
        }
        for f in archivos
    ]


@router.get("/history/download/{filename}")
def download_history(filename: str):
    path = CARPETA_SALIDA / filename
    if not path.exists():
        raise HTTPException(404)
    return FileResponse(str(path), media_type="audio/wav", filename=filename)


@router.delete("/history/{filename}")
def delete_history(filename: str):
    path = CARPETA_SALIDA / filename
    if path.exists():
        path.unlink()
    return {"ok": True}




@router.get("/voices")
def get_voices(api_key: str):
    try:
        r = requests.get(
            "https://api.elevenlabs.io/v1/voices",
            headers={"xi-api-key": api_key},
            timeout=10
        )
        if r.status_code == 200:
            voices = r.json().get("voices", [])
            return [{"id": v["voice_id"], "name": v["name"]} for v in voices]
    except Exception:
        pass
    return []


class GuionesConfigBody(BaseModel):
    user_id: int
    config: dict

@router.get("/config")
def get_guiones_config(user_id: int):
    """Load persisted panel config for a user from DB."""
    if not user_id:
        raise HTTPException(status_code=422, detail="user_id requerido")
    try:
        conn = _db_conn()
        with conn.cursor() as cur:
            cur.execute(
                "SELECT config_json FROM guiones_config WHERE user_id=%s",
                (user_id,),
            )
            row = cur.fetchone()
        conn.close()
        if row:
            cfg = row["config_json"]
            if isinstance(cfg, str):
                cfg = json.loads(cfg)
            return cfg
    except Exception as e:
        print(f"[guiones] get_config error: {e}")
    return {}

@router.post("/config")
def save_guiones_config(body: GuionesConfigBody):
    """Persist panel config for a user to DB."""
    if not body.user_id:
        raise HTTPException(status_code=422, detail="user_id requerido")
    try:
        conn = _db_conn()
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO guiones_config (user_id, config_json)
                VALUES (%s, %s)
                ON DUPLICATE KEY UPDATE config_json = %s, updated_at = CURRENT_TIMESTAMP
                """,
                (body.user_id, json.dumps(body.config), json.dumps(body.config)),
            )
        conn.close()
        return {"ok": True}
    except Exception as e:
        print(f"[guiones] save_config error: {e}")
        raise HTTPException(status_code=500, detail="Error guardando configuración")


class UserPrefsBody(BaseModel):
    user_id: str
    key_index: int

@router.get("/user-prefs")
def get_user_prefs(user_id: str):
    if not user_id:
        raise HTTPException(status_code=422, detail="user_id requerido")
    path = USER_PREFS_DIR / f"{hashlib.sha256(user_id.encode()).hexdigest()[:24]}.json"
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"key_index": -1}

@router.post("/user-prefs")
def save_user_prefs(body: UserPrefsBody):
    if not body.user_id:
        raise HTTPException(status_code=422, detail="user_id requerido")
    path = USER_PREFS_DIR / f"{hashlib.sha256(body.user_id.encode()).hexdigest()[:24]}.json"
    path.write_text(json.dumps({"key_index": body.key_index}, ensure_ascii=False), encoding="utf-8")
    return {"ok": True}


@router.get("/keys")
def get_predefined_keys():
    """Devuelve la lista de claves predefinidas (solo nombre e índice, sin exponer api_key)."""
    return [{"index": i, "name": k["name"]} for i, k in enumerate(PREDEFINED_KEYS)]


@router.get("/account-info")
def get_account_info(key_index: int):
    """
    Devuelve la info de suscripción de ElevenLabs para la clave seleccionada.
    También devuelve api_key y voice_id para que el frontend pueda aplicarlos al config.
    """
    if key_index < 0 or key_index >= len(PREDEFINED_KEYS):
        raise HTTPException(status_code=400, detail="Índice de clave inválido")
    key = PREDEFINED_KEYS[key_index]
    info = _get_subscription_info(key["api_key"])
    return {
        "name":              key["name"],
        "api_key":           key["api_key"],
        "voice_id":          key["voice_id"],
        "character_count":   info.get("character_count", 0),
        "character_limit":   info.get("character_limit", 0),
        "tier":              info.get("tier", ""),
        "next_reset":        info.get("next_reset", 0),
    }

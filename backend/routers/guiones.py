"""
Router de Automatización de Guiones
Toda la lógica de TTS, revisión y ensamblado de audio.
"""

import re
import os
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
from fastapi import APIRouter, HTTPException, BackgroundTasks
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

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

CARPETA_TEMP   = Path("temp_chunks")
CARPETA_SALIDA = Path("salida")
CARPETA_TEMP.mkdir(exist_ok=True)
CARPETA_SALIDA.mkdir(exist_ok=True)

# ── Persistencia: calibraciones y configuraciones ──────────────────────────
CALIB_DIR   = Path("data") / "voice_calibrations"
CONFIG_DIR  = Path("data") / "configs"
CALIB_DIR.mkdir(parents=True, exist_ok=True)
CONFIG_DIR.mkdir(parents=True, exist_ok=True)

# Puntos de referencia: cubre el rango usado + un poco más para no extrapolar en los bordes.
# El rango práctico es 0.89–1.0, así que los puntos van de 0.86 a 1.02.
SPEEDS_REFERENCIA = [0.86, 0.88, 0.89, 0.90, 0.92, 0.94, 0.96, 0.98, 1.00, 1.02]

# Rango "natural": el speed de ElevenLabs se mantiene aquí.
# Todo lo que queda fuera se compensa con tempo (ffmpeg atempo).
# Rango práctico real: 0.89–1.0.
SPEED_NATURAL_MIN = 0.89
SPEED_NATURAL_MAX = 1.00

# Sin puntuación → mide velocidad pura (sílabas)
TEXTO_REF_VELOCIDAD = (
    "Siente cómo tu respiración fluye naturalmente con calma y serenidad en cada momento de tu vida,"
    "permitiendo que la paz interior te envuelva suavemente mientras te sumerges en un estado de"
    "relajación profunda y bienestar absoluto."
)
# Con puntuación → mide pausas naturales de la voz (sin SSML breaks)
TEXTO_REF_PAUSAS = (
    "Respira, siente la calma, y relájate. Ahora... descansa completamente; "
    "sin esfuerzo: simplemente sé en paz."
    "Ahora, mientras inhalas, imagina que estás absorbiendo serenidad, y al exhalar,"
    "suelta cualquier tensión o preocupación que puedas tener."
)
# ───────────────────────────────────────────────────────────────────────────

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
    output_format: str = "mp3_44100_128"
    voice_settings: VoiceSettings = VoiceSettings()
    intro_voice_speed: float = 1.0
    intro_tempo_factor: float = 0.98
    afirm_voice_speed: float = 0.94
    afirm_tempo_factor: float = 0.95
    medit_voice_speed: float = 0.90
    medit_tempo_factor: float = 0.91
    pausa_entre_oraciones: int = 400
    pausa_entre_afirmaciones: int = 5000
    pausa_intro_a_afirm: int = 2000
    pausa_afirm_a_medit: int = 3000
    pausa_entre_meditaciones: int = 5000
    # SSML breaks por puntuación
    usar_ssml_breaks: bool = False
    break_coma: float = 0.5
    break_punto: float = 0.7
    break_suspensivos: float = 0.8
    break_dos_puntos: float = 0.4
    break_punto_coma: float = 0.6
    break_guion: float = 0.5
    break_exclamacion: float = 0.7
    break_interrogacion: float = 0.7
    break_parrafo: float = 1.0
    # Calentamiento de voz (warmup)
    usar_calentamiento: bool = True
    texto_calentamiento: str = "Cada minuto que paso dormido es un minuto de construcción de mi nuevo cuerpo."
    # Post-proceso
    extend_silence: bool = False
    factor_coma: float = 1.0
    factor_punto: float = 1.2
    factor_suspensivos: float = 1.5
    silence_thresh_db: int = -40
    silence_min_ms: int = 80
    max_chars_parrafo: int = 270
    min_chars_parrafo: int = 100

class GenerateRequest(BaseModel):
    guion: str
    config: Config
    nombre: str = "meditacion"

class ReviewDecision(BaseModel):
    job_id: str
    section: str
    index: int
    decision: str
    new_text: Optional[str] = None

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

def _atempo_chain(factor: float) -> str:
    filtros = []
    f = factor
    while f < 0.5:
        filtros.append("atempo=0.5")
        f /= 0.5
    while f > 2.0:
        filtros.append("atempo=2.0")
        f /= 2.0
    filtros.append(f"atempo={f:.6f}")
    return ",".join(filtros)

def aplicar_tempo(audio: "AudioSegment", factor: float) -> "AudioSegment":
    if factor == 1.0:
        return audio
    tmp_in  = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp_out = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp_in.close()
    tmp_out.close()
    try:
        audio.export(tmp_in.name, format="wav")
        subprocess.run(
            ["ffmpeg", "-y", "-i", tmp_in.name,
             "-filter:a", _atempo_chain(factor),
             "-ar", str(audio.frame_rate),
             "-c:a", "pcm_s16le",
             tmp_out.name],
            check=True, capture_output=True
        )
        return AudioSegment.from_wav(tmp_out.name)
    finally:
        os.unlink(tmp_in.name)
        os.unlink(tmp_out.name)

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

def insertar_breaks_ssml(texto: str, cfg: Config) -> str:
    if not cfg.usar_ssml_breaks:
        return texto

    def b(s): return f'<break time="{s}s"/>'

    reglas = []
    if cfg.break_suspensivos   > 0: reglas.append((r'\.\.\.|\u2026', cfg.break_suspensivos))
    if cfg.break_guion         > 0: reglas.append((r'---|—',         cfg.break_guion))
    if cfg.break_coma          > 0: reglas.append((r',',             cfg.break_coma))
    if cfg.break_punto         > 0: reglas.append((r'\.(?!\d)',      cfg.break_punto))
    if cfg.break_dos_puntos    > 0: reglas.append((r':(?!//)',       cfg.break_dos_puntos))
    if cfg.break_punto_coma    > 0: reglas.append((r';',             cfg.break_punto_coma))
    if cfg.break_exclamacion   > 0: reglas.append((r'!',             cfg.break_exclamacion))
    if cfg.break_interrogacion > 0: reglas.append((r'\?',            cfg.break_interrogacion))

    if reglas:
        combined = '|'.join(f'({patron})' for patron, _ in reglas)
        tiempos  = [t for _, t in reglas]
        def _reemplazar(m):
            for i, t in enumerate(tiempos):
                if m.group(i + 1) is not None:
                    return f'{m.group(i + 1)} {b(t)}'
            return m.group(0)
        t = re.sub(combined, _reemplazar, texto)
    else:
        t = texto

    # Párrafos: si ya hay un break antes del \n\n, reemplazarlo por break_parrafo
    # Solo reemplazar si el break existente es menor que break_parrafo; si es mayor, conservarlo.
    if cfg.break_parrafo > 0:
        brk = b(cfg.break_parrafo)
        t = re.sub(
            r' <break time="([\d.]+)s"/>([ \t]*\n[ \t]*\n)',
            lambda m: (f' <break time="{m.group(1)}s"/>{m.group(2)}'
                       if float(m.group(1)) >= cfg.break_parrafo
                       else f' {brk}{m.group(2)}'),
            t
        )
        t = re.sub(r'(?<!/>)([ \t]*\n[ \t]*\n)', f' {brk}\\1', t)

    # Eliminar breaks sobrantes al final
    t = re.sub(r'(\s*<break time="[\d.]+s"/>)+\s*$', '', t).strip()
    return t


def _break_largo(ms: int, max_s: float = 3.0) -> str:
    """Convierte ms a serie de <break/> de máx max_s s (límite ElevenLabs)."""
    restante = ms / 1000
    partes = []
    while restante > max_s:
        partes.append(f'<break time="{max_s:.1f}s"/>')
        restante -= max_s
    if restante > 0:
        partes.append(f'<break time="{restante:.1f}s"/>')
    return ' '.join(partes)


def texto_a_audio_api(texto: str, ruta_salida: Path,
                      voice_speed: float, cfg: Config,
                      skip_punctuation_breaks: bool = False) -> bool:
    fmt = getattr(cfg, "output_format", "mp3_44100_128") or "mp3_44100_128"
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{cfg.voice_id}?output_format={fmt}"
    headers = {"xi-api-key": cfg.api_key, "Content-Type": "application/json"}
    if skip_punctuation_breaks:
        # Para intro/meditación: conservar breaks ya existentes en el texto (ej. calentamiento)
        # pero no agregar nuevos por puntuación ni reemplazar comas.
        texto_tts = texto.strip()
    else:
        texto_api = texto.replace(",", ", ---")
        texto_tts = insertar_breaks_ssml(texto_api, cfg)
        if not cfg.usar_ssml_breaks:
            texto_tts = re.sub(r'<break\b[^>]*/>', '', texto_tts)
        texto_tts = texto_tts.strip()
    payload = {
        "text": texto_tts,
        "model_id": cfg.model_id,
        "language_code": cfg.language_code,
        "voice_settings": {**cfg.voice_settings.model_dump(), "speed": voice_speed},
    }
    for intento in range(1, 4):
        try:
            r = requests.post(url, json=payload, headers=headers, timeout=60)
            if r.status_code == 200:
                ruta_salida.write_bytes(r.content)
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


def _trim_calentamiento(audio: "AudioSegment") -> "AudioSegment":
    """
    Elimina del inicio del audio el texto de calentamiento.
    Busca el primer silencio >= 300 ms después de los primeros 800 ms
    (tiempo mínimo que ocupa la oración de calentamiento) y corta ahí.
    """
    min_start_ms = 800
    silencios = detect_silence(
        audio[min_start_ms:],
        min_silence_len=300,
        silence_thresh=-38,
    )
    if silencios:
        s_ini, s_fin = silencios[0]
        corte = min_start_ms + (s_ini + s_fin) // 2
        recortado = audio[corte:]
        return recortado if len(recortado) > 200 else audio
    return audio


def cargar_oracion(texto: str, carpeta: Path, prefijo: str, indice: int,
                   voice_speed: float, tempo_factor: float, cfg: Config,
                   force_regen: bool = False) -> Optional["AudioSegment"]:
    settings_dict = cfg.voice_settings.model_dump()
    fmt = getattr(cfg, "output_format", "mp3_44100_128") or "mp3_44100_128"
    ruta = ruta_cache(carpeta, prefijo, indice, texto, voice_speed, settings_dict, fmt)
    if force_regen and ruta.exists():
        ruta.unlink()
    if not ruta.exists():
        usar_warmup = (
            cfg.usar_calentamiento
            and cfg.texto_calentamiento
            and prefijo in ("intro", "medit")
        )
        es_intro_medit = prefijo in ("intro", "medit")
        if usar_warmup:
            calentamiento_con_break = re.sub(r'\s*$', ' <break time="1.0s"/>', cfg.texto_calentamiento.rstrip())
            texto_api = calentamiento_con_break + "\n\n" + texto
            tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
            tmp.close()
            tmp_path = Path(tmp.name)
            try:
                ok = texto_a_audio_api(texto_api, tmp_path, voice_speed, cfg,
                                       skip_punctuation_breaks=es_intro_medit)
                if not ok:
                    return None
                audio_raw = _load_audio(tmp_path, fmt)
                audio_trimmed = _trim_calentamiento(audio_raw)
                audio_trimmed.export(str(ruta), format="wav")
            finally:
                tmp_path.unlink(missing_ok=True)
        else:
            ok = texto_a_audio_api(texto, ruta, voice_speed, cfg,
                                   skip_punctuation_breaks=es_intro_medit)
            if not ok:
                return None
    audio = _load_audio(ruta, fmt)
    if cfg.extend_silence:
        audio = extender_silencios_internos(audio, cfg)
    if tempo_factor != 1.0:
        audio = aplicar_tempo(audio, tempo_factor)
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

def _construir_bloques(texto: str, cfg: Config) -> list[str]:
    """
    Divide el texto en bloques para TTS.
    Trata cada línea como unidad y las fusiona con \\n\\n hasta alcanzar
    min_chars, preservando la estructura para que insertar_breaks_ssml
    pueda agregar los breaks de párrafo correctamente.
    """
    lineas = [l.strip() for l in texto.splitlines() if l.strip()]

    fusionados: list[str] = []
    buffer = ""
    for linea in lineas:
        if not buffer:
            buffer = linea
        else:
            if len(buffer) < cfg.min_chars_parrafo:
                candidato = buffer + "\n\n" + linea
                if len(candidato) <= cfg.max_chars_parrafo:
                    buffer = candidato
                else:
                    fusionados.append(buffer)
                    buffer = linea
            else:
                fusionados.append(buffer)
                buffer = linea
    if buffer:
        if (fusionados
                and len(buffer) < cfg.min_chars_parrafo
                and len(fusionados[-1]) + 2 + len(buffer) <= cfg.max_chars_parrafo):
            fusionados[-1] = fusionados[-1] + "\n\n" + buffer
        else:
            fusionados.append(buffer)

    bloques: list[str] = []
    for bloque in fusionados:
        if len(bloque) <= cfg.max_chars_parrafo:
            bloques.append(bloque)
        else:
            oraciones = re.split(r'(?<=[.!?])\s+', bloque)
            bloque_actual = ""
            for oracion in oraciones:
                if len(bloque_actual) + len(oracion) + 2 <= cfg.max_chars_parrafo:
                    bloque_actual += ("\n\n" if bloque_actual else "") + oracion
                else:
                    if bloque_actual:
                        bloques.append(bloque_actual)
                    bloque_actual = oracion
            if bloque_actual:
                bloques.append(bloque_actual)

    return bloques


def _construir_bloques_afirm(texto: str, cfg: Config) -> tuple[list[str], list[list[str]]]:
    """
    Para afirmaciones: fusiona líneas cortas respetando min/max chars.
    Usa _break_largo como separador para mantener los 10 s entre afirmaciones
    incluso cuando quedan en el mismo bloque.

    Returns:
        bloques_texto  : list[str]        — texto fusionado para TTS
        lineas_x_bloque: list[list[str]]  — líneas originales de cada bloque
                                            (para dividir el audio después)
    """
    sep = _break_largo(_SSML_SPLIT_PAUSE_MS)
    lineas = [l.strip() for l in texto.splitlines() if l.strip()]

    grupos_t: list[str]        = []   # texto TTS de cada grupo
    grupos_l: list[list[str]]  = []   # líneas originales de cada grupo

    buf_t = ""
    buf_l: list[str] = []

    for linea in lineas:
        if not buf_t:
            buf_t = linea
            buf_l = [linea]
        elif len(buf_t) < cfg.min_chars_parrafo:
            candidato = buf_t + " " + sep + "\n\n" + linea
            if len(candidato) <= cfg.max_chars_parrafo:
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
                and len(buf_t) < cfg.min_chars_parrafo
                and len(grupos_t[-1]) + len(sep) + 2 + len(buf_t) <= cfg.max_chars_parrafo):
            grupos_t[-1] = grupos_t[-1] + " " + sep + "\n\n" + buf_t
            grupos_l[-1].extend(buf_l)
        else:
            grupos_t.append(buf_t);  grupos_l.append(buf_l)

    # Resolver grupos que superen max_chars: dividir línea a línea
    bloques_t: list[str]       = []
    bloques_l: list[list[str]] = []
    for g_t, g_l in zip(grupos_t, grupos_l):
        if len(g_t) <= cfg.max_chars_parrafo:
            bloques_t.append(g_t);  bloques_l.append(g_l)
        else:
            for linea in g_l:
                bloques_t.append(linea);  bloques_l.append([linea])

    return bloques_t, bloques_l


# Pausa SSML interna entre afirmaciones agrupadas (solo para detectar el punto de corte).
# No es la pausa final del audio: esa se añade en el ensamblado y la controla el usuario.
# 3 s es más que suficiente para la detección; reduce el tiempo de TTS respecto a 10 s.
_SSML_SPLIT_PAUSE_MS = 3000


def _trim_silence(
    seg: "AudioSegment",
    thresh_db: int = -38,
    chunk_ms: int = 10,
    keep_ms: int = 80,
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


def _split_audio_at_silences(
    audio: "AudioSegment",
    n: int,
    min_silence_ms: int = 1500,
    silence_thresh_db: int = -38
) -> list["AudioSegment"]:
    """
    Divide `audio` en exactamente `n` segmentos usando los (n-1) silencios
    más largos como puntos de corte (se corta en el punto medio del silencio).

    Garantías:
    - Siempre devuelve una lista de exactamente `n` AudioSegment.
    - Si no hay suficientes silencios detectables, hace fallback a división
      por duración igual (mejor que nada y sin riesgo de IndexError).
    """
    if n == 1:
        return [audio]

    silencios = detect_silence(audio, min_silence_len=min_silence_ms,
                               silence_thresh=silence_thresh_db)

    if len(silencios) >= n - 1:
        # Tomamos los (n-1) silencios más largos, ordenados por posición
        top = sorted(
            sorted(silencios, key=lambda s: s[1] - s[0], reverse=True)[: n - 1],
            key=lambda s: s[0],
        )
        segmentos: list["AudioSegment"] = []
        prev = 0
        for s_ini, s_fin in top:
            mid = (s_ini + s_fin) // 2
            segmentos.append(audio[prev:mid])
            prev = mid
        segmentos.append(audio[prev:])
        return segmentos

    # Fallback: división equitativa por duración
    dur = len(audio)
    chunk = dur // n
    return [
        audio[i * chunk : (i + 1) * chunk if i < n - 1 else dur]
        for i in range(n)
    ]

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
                      voice_speed: float, tempo_factor: float,
                      cfg: Config, event_ready: str,
                      event_regenerating: str):
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
                audio = cargar_oracion(
                    items[i], carpeta, prefijo, i,
                    voice_speed, tempo_factor, cfg,
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

# =============================================================
#  JOB DE GENERACIÓN
# =============================================================

def run_generation_job(job_id: str, guion: str, cfg: Config, nombre: str):
    try:
        jobs[job_id]["status"] = "running"
        carpeta = CARPETA_TEMP / nombre
        carpeta.mkdir(parents=True, exist_ok=True)

        secciones   = detectar_secciones(guion)
        tiene_intro = bool(secciones["intro"])
        tiene_afirm = bool(secciones["afirmaciones"])
        tiene_medit = bool(secciones.get("meditacion", ""))

        emit_event(job_id, "start", {
            "tiene_intro": tiene_intro,
            "tiene_afirm": tiene_afirm,
            "tiene_medit": tiene_medit,
            "message": "Iniciando generación..."
        })

        # ── INTRO ─────────────────────────────────────────────
        bloques_intro = []
        if tiene_intro:
            bloques_intro = _construir_bloques(secciones["intro"], cfg)
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
                audio = cargar_oracion(bloque, carpeta, "intro", i,
                                       cfg.intro_voice_speed, cfg.intro_tempo_factor, cfg)
                if audio:
                    audio_url = _guardar_preview(audio, job_id, "intro", i)
                    emit_event(job_id, "intro_ready", {
                        "index": i, "section": "intro",
                        "text": bloque, "audio_url": audio_url,
                        "message": f"Segmento de intro {i + 1} listo"
                    })

            emit_event(job_id, "intro_review_start", {
                "message": "Intro generada. Esperando revisión...",
                "total": len(bloques_intro)
            })
            jobs[job_id]["status"] = "awaiting_review"

            _esperar_revision(
                job_id, "intro", bloques_intro, carpeta, "intro",
                cfg.intro_voice_speed, cfg.intro_tempo_factor, cfg,
                event_ready="intro_ready", event_regenerating="intro_regenerating"
            )
            emit_event(job_id, "intro_review_done", {"message": "Revisión de intro completada"})

        # ── AFIRMACIONES ──────────────────────────────────────
        afirmaciones = []
        if tiene_afirm:
            # Grupos para TTS (fusionados para cumplir min_chars) +
            # líneas originales por grupo (para dividir el audio después)
            afirm_grupos, afirm_lineas_x_grupo = _construir_bloques_afirm(
                secciones["afirmaciones"], cfg
            )
            # Lista plana de afirmaciones individuales (una por card de revisión)
            afirmaciones = [l for lineas in afirm_lineas_x_grupo for l in lineas]
            jobs[job_id]["afirmaciones"]    = afirmaciones
            jobs[job_id]["afirm_decisions"] = {}

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

                # Genera el audio del grupo completo (puede contener varias afirmaciones)
                audio = cargar_oracion(
                    grupo_texto, carpeta, "afirm_grp", i,
                    cfg.afirm_voice_speed, cfg.afirm_tempo_factor, cfg
                )

                if audio and n_en_grupo > 1:
                    # Separa el audio en segmentos individuales en los silencios SSML
                    # y recorta el silencio sobrante de cada extremo
                    segmentos = [_trim_silence(s) for s in _split_audio_at_silences(audio, n_en_grupo)]
                elif audio:
                    segmentos = [_trim_silence(audio)]
                else:
                    segmentos = [None] * n_en_grupo

                for linea, seg in zip(grupo_lineas, segmentos):
                    if seg is not None:
                        audio_url = _guardar_preview(seg, job_id, "afirm", flat_idx)
                        emit_event(job_id, "afirm_ready", {
                            "index": flat_idx, "section": "afirm",
                            "text": linea, "audio_url": audio_url,
                            "message": f"Afirmación {flat_idx + 1} lista"
                        })
                    flat_idx += 1

            emit_event(job_id, "afirm_review_start", {
                "message": "Afirmaciones generadas. Esperando revisión...",
                "total": len(afirmaciones)
            })
            jobs[job_id]["status"] = "awaiting_review"

            _esperar_revision(
                job_id, "afirm", afirmaciones, carpeta, "afirm",
                cfg.afirm_voice_speed, cfg.afirm_tempo_factor, cfg,
                event_ready="afirm_ready", event_regenerating="afirm_regenerating"
            )
            emit_event(job_id, "afirm_review_done", {"message": "Revisión de afirmaciones completada"})

        # ── MEDITACIÓN ────────────────────────────────────────
        bloques_medit = []
        if tiene_medit:
            bloques_medit = _construir_bloques(secciones["meditacion"], cfg)
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
                audio = cargar_oracion(bloque, carpeta, "medit", i,
                                       cfg.medit_voice_speed, cfg.medit_tempo_factor, cfg)
                if audio:
                    audio_url = _guardar_preview(audio, job_id, "medit", i)
                    emit_event(job_id, "medit_ready", {
                        "index": i, "section": "medit",
                        "text": bloque, "audio_url": audio_url,
                        "message": f"Segmento de meditación {i + 1} listo"
                    })

            emit_event(job_id, "medit_review_start", {
                "message": "Meditación generada. Esperando revisión...",
                "total": len(bloques_medit)
            })
            jobs[job_id]["status"] = "awaiting_review"

            _esperar_revision(
                job_id, "medit", bloques_medit, carpeta, "medit",
                cfg.medit_voice_speed, cfg.medit_tempo_factor, cfg,
                event_ready="medit_ready", event_regenerating="medit_regenerating"
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

        jobs[job_id]["status"]        = "done"
        jobs[job_id]["output_file"]   = str(ruta_salida)
        jobs[job_id]["duration_mins"] = round(mins, 1)

        emit_event(job_id, "done", {
            "message": f"Audio generado: {mins:.1f} min",
            "download_url": f"/api/download/{job_id}",
            "duration_mins": round(mins, 1)
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
def submit_review(decision: ReviewDecision):
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


# ═══ Helpers de calibración de referencia ═══════════════════════════════════

_VOWELS = set("aeiouáéíóúàèìòùäëïöüâêîôûyAEIOUÁÉÍÓÚÀÈÌÒÙÄËÏÖÜÂÊÎÔÛY")

def _contar_silabas(texto: str) -> int:
    """Cuenta núcleos vocálicos como proxy de sílabas.
    Funciona para ES, EN y cualquier idioma de script latino."""
    texto = re.sub(r'<[^>]+>', '', texto)
    count, in_vowel = 0, False
    for c in texto:
        if c in _VOWELS:
            if not in_vowel:
                count += 1
                in_vowel = True
        else:
            in_vowel = False
    return max(count, 1)


def _medir_tasa_whisper(audio_bytes: bytes, ext: str = ".mp3",
                        known_text: str = None) -> float:
    """Mide sílabas/segundo con Whisper (word timestamps).
    - known_text: usar este texto para el conteo (referencias → texto exacto conocido).
    - Sin known_text: usa la transcripción automática (audio del usuario → cualquier idioma).
    Retorna 0.0 si Whisper no está disponible o falla."""
    if not WHISPER_AVAILABLE:
        return 0.0
    with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name
    try:
        model = _get_whisper_model()
        result = model.transcribe(tmp_path, word_timestamps=True,
                                  language=None, verbose=False)
        words = [w for seg in result.get("segments", [])
                 for w in seg.get("words", [])]
        if not words:
            return 0.0
        # Duración neta de habla: suma de duraciones de palabras (excluye pausas)
        speech_dur = sum(w["end"] - w["start"] for w in words)
        if speech_dur < 0.5:
            return 0.0
        text_for_count = known_text if known_text else result.get("text", "")
        return _contar_silabas(text_for_count) / speech_dur
    except Exception:
        return 0.0
    finally:
        Path(tmp_path).unlink(missing_ok=True)


def _medir_silabico_seg(seg, silencios: list) -> int:
    """Intervalo silábico mediano (ms) a partir de un AudioSegment ya cargado."""
    dur_ms = len(seg)
    frame_ms = 8
    rms_frames = [seg[i:i + frame_ms].rms for i in range(0, dur_ms - frame_ms, frame_ms)]
    n = len(rms_frames)
    if n < 50:
        return 0
    voiced = [True] * n
    for s, e in silencios:
        for j in range(s // frame_ms, min(e // frame_ms + 1, n)):
            voiced[j] = False
    smoothed = [0.0] * n
    for i in range(n):
        lo, hi = max(0, i - 3), min(n, i + 4)
        sub = rms_frames[lo:hi]
        smoothed[i] = sum(sub) / len(sub)
    voiced_vals = [smoothed[i] for i in range(n) if voiced[i]]
    if len(voiced_vals) < 50:
        return 0
    thr = statistics.mean(voiced_vals) * 0.45
    peaks, last_p = [], -9999
    for i in range(1, n - 1):
        if (voiced[i]
                and smoothed[i] > smoothed[i - 1]
                and smoothed[i] > smoothed[i + 1]
                and smoothed[i] > thr
                and (i - last_p) * frame_ms >= 80):
            peaks.append(i)
            last_p = i
    if len(peaks) < 8:
        return 0
    inter = [(peaks[k + 1] - peaks[k]) * frame_ms for k in range(len(peaks) - 1)]
    syl_iv = [d for d in inter if 80 <= d <= 380]
    return round(statistics.median(syl_iv)) if len(syl_iv) >= 6 else 0


def _medir_silabico_bytes(audio_bytes: bytes, ext: str = ".mp3") -> int:
    """Wrapper: carga desde bytes y delega en _medir_silabico_seg."""
    with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name
    try:
        seg = AudioSegment.from_file(tmp_path).set_channels(1)
        if len(seg) < 1000:
            return 0
        thresh = seg.dBFS - 14
        silencios = detect_silence(seg, min_silence_len=150, silence_thresh=thresh)
        return _medir_silabico_seg(seg, silencios)
    finally:
        Path(tmp_path).unlink(missing_ok=True)


def _medir_pausas_naturales_bytes(audio_bytes: bytes, ext: str = ".mp3") -> dict:
    """Mide las pausas naturales de la voz (sin SSML) clasificadas por duración."""
    with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name
    try:
        seg = AudioSegment.from_file(tmp_path).set_channels(1)
        thresh = seg.dBFS - 14
        silencios = detect_silence(seg, min_silence_len=80, silence_thresh=thresh)
        durs = [e - s for s, e in silencios if e - s <= 4000]
        cortos = [d for d in durs if d < 350]
        medios  = [d for d in durs if 350 <= d < 900]
        largos  = [d for d in durs if d >= 900]
        def _avg(lst, default):
            return round(statistics.mean(lst)) if len(lst) >= 2 else default
        return {
            "natural_coma_ms":    _avg(cortos, 120),
            "natural_punto_ms":   _avg(medios,  380),
            "natural_parrafo_ms": _avg(largos,  850),
        }
    finally:
        Path(tmp_path).unlink(missing_ok=True)


def _calib_path(voice_id: str, model_id: str) -> Path:
    safe = lambda s: "".join(c for c in s if c.isalnum() or c in "-_")[:40]
    return CALIB_DIR / f"{safe(voice_id)}_{safe(model_id)}.json"


def _load_calib(voice_id: str, model_id: str):
    p = _calib_path(voice_id, model_id)
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            pass
    return None


def _ref_rate_at_speed(target_speed: float, points: list) -> float:
    """Sílabas/segundo esperadas a una velocidad dada (interpolación lineal entre puntos).
    Si target_speed está fuera del rango, extrapola usando la relación rate ∝ speed."""
    pts = sorted(points, key=lambda p: p["speed"])
    for i in range(len(pts) - 1):
        lo, hi = pts[i], pts[i + 1]
        if lo["speed"] <= target_speed <= hi["speed"]:
            t = (target_speed - lo["speed"]) / (hi["speed"] - lo["speed"])
            return lo["sils_per_sec"] + t * (hi["sils_per_sec"] - lo["sils_per_sec"])
    # Extrapolación: usar punto speed=1.0 como baseline (rate ∝ speed)
    base = next((p for p in pts if abs(p["speed"] - 1.0) < 0.01), pts[len(pts) // 2])
    return base["sils_per_sec"] * target_speed


def _speed_tempo_from_rate(user_rate: float, points: list) -> tuple:
    """Dado el ritmo del usuario en síls/seg, devuelve (speed, tempo).
    Mantiene speed en [SPEED_NATURAL_MIN, SPEED_NATURAL_MAX] y usa tempo para el resto."""
    pts = sorted(points, key=lambda p: p["speed"])
    ref_at_min = _ref_rate_at_speed(SPEED_NATURAL_MIN, pts)
    ref_at_max = _ref_rate_at_speed(SPEED_NATURAL_MAX, pts)

    if user_rate <= ref_at_min:
        # Audio más lento que el límite inferior → speed=MIN, tempo < 1.0
        return SPEED_NATURAL_MIN, round(user_rate / ref_at_min, 3)
    if user_rate >= ref_at_max:
        # Audio más rápido que el límite superior → speed=MAX, tempo > 1.0
        return SPEED_NATURAL_MAX, round(user_rate / ref_at_max, 3)
    # Dentro del rango natural: solo ajustar speed, tempo=1.0
    for i in range(len(pts) - 1):
        lo, hi = pts[i], pts[i + 1]
        lo_r, hi_r = lo["sils_per_sec"], hi["sils_per_sec"]
        if lo_r <= user_rate <= hi_r and hi_r != lo_r:
            t = (user_rate - lo_r) / (hi_r - lo_r)
            speed = round(lo["speed"] + t * (hi["speed"] - lo["speed"]), 2)
            return speed, 1.0
    return round(SPEED_NATURAL_MIN + (user_rate - ref_at_min) /
                 max(ref_at_max - ref_at_min, 1e-6) *
                 (SPEED_NATURAL_MAX - SPEED_NATURAL_MIN), 2), 1.0

# ════════════════════════════════════════════════════════════════════════════


class CalibracionRequest(BaseModel):
    audio_b64: str
    filename: str  = "audio.mp3"
    seccion: str   = "intro"   # "intro" | "meditacion" | "afirmaciones"
    voice_id: str  = ""        # para usar tabla de calibración de referencia
    model_id: str  = ""


class CalibReferenciasRequest(BaseModel):
    api_key: str
    voice_id: str
    model_id: str       = "eleven_multilingual_v2"
    language_code: str  = "es"


@router.post("/calibrar-voz")
def calibrar_voz(body: CalibracionRequest):
    """
    Analiza un audio de referencia enviado como base64 JSON.
    Extrae patrones de silencio → break times SSML
    Extrae ratio habla/silencio → velocidad de voz
    """
    if not PYDUB_AVAILABLE:
        raise HTTPException(status_code=500, detail="pydub no disponible")

    FORMATOS = {".mp3", ".wav", ".m4a", ".ogg", ".flac", ".aac", ".webm"}
    ext = Path(body.filename).suffix.lower()
    if ext not in FORMATOS:
        raise HTTPException(status_code=422, detail=f"Formato no soportado. Usa: {', '.join(FORMATOS)}")

    try:
        audio_bytes = base64.b64decode(body.audio_b64)
    except Exception:
        raise HTTPException(status_code=422, detail="audio_b64 no es base64 válido")

    MAX_BYTES = 30 * 1024 * 1024  # 30 MB
    if len(audio_bytes) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="El audio supera el límite de 30 MB")

    # Guardar en temp
    with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name

    try:
        try:
            seg = AudioSegment.from_file(tmp_path).set_channels(1)
        except Exception as e:
            raise HTTPException(status_code=422, detail=f"No se pudo leer el audio: {str(e)}")

        dur_ms = len(seg)

        if dur_ms < 3000:
            raise HTTPException(status_code=422, detail="El audio debe tener al menos 3 segundos")

        # Umbral dinámico: 14 dB por encima del nivel medio de ruido
        thresh = seg.dBFS - 14

        silencios = detect_silence(seg, min_silence_len=150, silence_thresh=thresh)
        duraciones = [end - start for start, end in silencios]

        # Filtrar silencios de intro/outro (>5s) — no representan pausas de habla
        duraciones = [d for d in duraciones if d <= 5000]

        # Clasificar por duración natural del habla
        cortos  = [d for d in duraciones if d < 450]          # coma-level  ~200-450ms
        medios  = [d for d in duraciones if 450 <= d < 1100]  # punto-level ~450-1100ms
        largos  = [d for d in duraciones if 1100 <= d <= 5000] # párrafo    >1100ms

        def promedio(lst, default_ms):
            return statistics.mean(lst) if len(lst) >= 2 else default_ms

        avg_corto  = promedio(cortos,  350)
        avg_medio  = promedio(medios,  700)
        avg_largo  = promedio(largos, 1800)

        # Convertir a segundos con límites razonables para ElevenLabs
        break_coma        = round(max(0.2, min(avg_corto  / 1000, 1.5)), 2)
        break_punto       = round(max(0.4, min(avg_medio  / 1000, 2.5)), 2)
        break_parrafo     = round(max(0.8, min(avg_largo  / 1000, 3.0)), 2)

        # Derivar los demás proporcionalmente
        break_suspensivos   = round(min(break_punto * 1.15, 3.0), 2)
        break_dos_puntos    = round(max(break_coma * 0.80, 0.2), 2)
        break_punto_coma    = round((break_coma + break_punto) / 2, 2)
        break_exclamacion   = round(break_punto, 2)
        break_interrogacion = round(break_punto, 2)
        break_guion         = round(break_coma, 2)

        # ── Velocidad + Tempo: medición con Whisper (speech rate en síls/seg) ──
        # Whisper detecta las palabras con timestamps exactos → duración neta de habla
        # sin pausas → tasa de sílabas/seg independiente del contenido y el idioma.
        # Los puntos de calibración (generados una vez por voz) mapean speed→síls/seg,
        # permitiendo encontrar el speed exacto de ElevenLabs.
        total_silencio_ms = sum(end - start for start, end in silencios)
        habla_ms    = max(dur_ms - total_silencio_ms, 0)
        ratio_habla = habla_ms / dur_ms

        calib = _load_calib(body.voice_id, body.model_id) if body.voice_id else None
        pts   = [p for p in (calib.get("points", []) if calib else [])
                 if "sils_per_sec" in p]

        # Medir tasa del audio del usuario (auto-detect idioma, sin texto conocido)
        user_rate = _medir_tasa_whisper(audio_bytes, ext)

        if user_rate > 0 and len(pts) >= 5:
            # Camino principal: tabla de calibración + Whisper → máxima precisión
            speed, tempo = _speed_tempo_from_rate(user_rate, pts)
        elif user_rate > 0:
            # Sin tabla de calibración: estimación genérica
            # A speed=1.0 la mayoría de voces ElevenLabs hablan ~4.5 síls/seg
            GENERIC_RATE_1 = 4.5
            effective = user_rate / GENERIC_RATE_1
            if effective < SPEED_NATURAL_MIN:
                speed = SPEED_NATURAL_MIN
                tempo = round(effective / SPEED_NATURAL_MIN, 3)
            elif effective > SPEED_NATURAL_MAX:
                speed = SPEED_NATURAL_MAX
                tempo = round(effective / SPEED_NATURAL_MAX, 3)
            else:
                speed = round(effective, 2)
                tempo = 1.0
        else:
            # Fallback: método de energía (si Whisper no está disponible)
            med_syl_ms = _medir_silabico_seg(seg, silencios)
            if med_syl_ms > 0:
                speed = round(min(max(185.0 / med_syl_ms, 0.70), 1.20), 2)
            else:
                speed = 0.93
            tempo = 1.0
            user_rate = 0.0

        speed = round(max(0.70, min(speed, 1.20)), 2)
        tempo = round(max(0.50, min(tempo, 1.50)), 3)

        # ── Ajuste de breaks: restar las pausas naturales de la voz ──────────
        # El SSML break = pausa deseada − lo que la voz ya inserta sola.
        # Esto evita pausas dobles cuando ElevenLabs ya pausa en puntuación.
        if calib and calib.get("natural_pauses"):
            np = calib["natural_pauses"]
            nat_coma    = np.get("natural_coma_ms",    120) / 1000
            nat_punto   = np.get("natural_punto_ms",   380) / 1000
            nat_parrafo = np.get("natural_parrafo_ms", 850) / 1000
            break_coma    = round(max(0.0, break_coma    - nat_coma),    2)
            break_punto   = round(max(0.0, break_punto   - nat_punto),   2)
            break_parrafo = round(max(0.0, break_parrafo - nat_parrafo), 2)
            # Re-derivar proporcionales
            break_suspensivos   = round(min(break_punto * 1.15, 3.0), 2)
            break_dos_puntos    = round(max(break_coma  * 0.80, 0.0), 2)
            break_punto_coma    = round((break_coma + break_punto) / 2,  2)
            break_exclamacion   = round(break_punto, 2)
            break_interrogacion = round(break_punto, 2)
            break_guion         = round(break_coma,  2)

        # Solo se devuelve el parámetro de velocidad de la sección solicitada
        SECTION_KEYS = {
            "intro":        ("intro_voice_speed", "intro_tempo_factor"),
            "meditacion":   ("medit_voice_speed",  "medit_tempo_factor"),
            "afirmaciones": ("afirm_voice_speed",  "afirm_tempo_factor"),
        }
        speed_key, tempo_key = SECTION_KEYS.get(body.seccion, ("intro_voice_speed", "intro_tempo_factor"))

        sugerencias = {
            "break_coma":          break_coma,
            "break_punto":         break_punto,
            "break_suspensivos":   break_suspensivos,
            "break_dos_puntos":    break_dos_puntos,
            "break_punto_coma":    break_punto_coma,
            "break_exclamacion":   break_exclamacion,
            "break_interrogacion": break_interrogacion,
            "break_guion":         break_guion,
            "break_parrafo":       break_parrafo,
            speed_key:             speed,
        }
        # Solo incluir tempo si difiere de 1.0 (evitar ruido innecesario)
        if abs(tempo - 1.0) >= 0.01:
            sugerencias[tempo_key] = tempo

        return {
            "seccion": body.seccion,
            "sugerencias": sugerencias,
            "analisis": {
                "duracion_s":           round(dur_ms / 1000, 1),
                "ratio_habla":          round(ratio_habla, 3),
                "silencios_detectados": len(duraciones),
                "sils_per_sec":         round(user_rate, 2) if user_rate > 0 else None,
                "calibrado":            bool(calib and len(pts) >= 5),
                "pausa_media_avg_ms":   round(avg_medio),
                "pausa_larga_avg_ms":   round(avg_largo),
            },
        }
    finally:
        Path(tmp_path).unlink(missing_ok=True)


# ── Endpoints de generación y consulta de referencias ───────────────────────

@router.post("/calibrar-voz/referencias")
def generar_referencias(body: CalibReferenciasRequest):
    """
    Genera 11 audios de referencia (speed 0.70–1.20) con la voz configurada
    y 1 audio adicional para medir pausas naturales.
    Guarda la tabla de calibración en disco para uso posterior.
    Tiempo estimado: 20–40 s según latencia de ElevenLabs.
    """
    if not PYDUB_AVAILABLE:
        raise HTTPException(status_code=500, detail="pydub no disponible")

    points, errors = [], []

    for speed in SPEEDS_REFERENCIA:
        try:
            resp = requests.post(
                f"https://api.elevenlabs.io/v1/text-to-speech/{body.voice_id}",
                headers={"xi-api-key": body.api_key, "Content-Type": "application/json"},
                json={
                    "text": TEXTO_REF_VELOCIDAD,
                    "model_id": body.model_id,
                    "language_code": body.language_code,
                    "voice_settings": {
                        "stability": 0.5,
                        "similarity_boost": 0.75,
                        "style": 0.0,
                        "use_speaker_boost": False,
                        "speed": speed,
                    },
                },
                timeout=30,
            )
            if resp.status_code != 200:
                errors.append({"speed": speed, "error": f"HTTP {resp.status_code}"})
                continue
            # Usamos el texto exacto conocido para el conteo de sílabas (más preciso)
            rate = _medir_tasa_whisper(resp.content, ".mp3",
                                       known_text=TEXTO_REF_VELOCIDAD)
            if rate > 0:
                points.append({"speed": speed, "sils_per_sec": round(rate, 4)})
            else:
                errors.append({"speed": speed, "error": "Whisper no pudo medir la tasa"})
        except Exception as exc:
            errors.append({"speed": speed, "error": str(exc)})

    if len(points) < 5:
        raise HTTPException(
            status_code=500,
            detail=f"Solo {len(points)} puntos de calibración obtenidos. Errores: {errors}",
        )

    # Pausas naturales de la voz a speed=1.0 (para ajuste de breaks)
    natural_pauses = {}
    try:
        resp_p = requests.post(
            f"https://api.elevenlabs.io/v1/text-to-speech/{body.voice_id}",
            headers={"xi-api-key": body.api_key, "Content-Type": "application/json"},
            json={
                "text": TEXTO_REF_PAUSAS,
                "model_id": body.model_id,
                "language_code": body.language_code,
                "voice_settings": {
                    "stability": 0.5,
                    "similarity_boost": 0.75,
                    "style": 0.0,
                    "use_speaker_boost": False,
                    "speed": 1.0,
                },
            },
            timeout=30,
        )
        if resp_p.status_code == 200:
            natural_pauses = _medir_pausas_naturales_bytes(resp_p.content, ".mp3")
    except Exception:
        pass  # las pausas naturales son opcionales

    calib_data = {
        "voice_id":      body.voice_id,
        "model_id":      body.model_id,
        "language_code": body.language_code,
        "generated_at":  time.strftime("%Y-%m-%dT%H:%M:%S"),
        "points":        points,
        "natural_pauses": natural_pauses,
    }
    _calib_path(body.voice_id, body.model_id).write_text(
        json.dumps(calib_data, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return {"ok": True, "points": points, "natural_pauses": natural_pauses, "errors": errors}


# ── Config persistence ───────────────────────────────────────────────────────

class ConfigBody(BaseModel):
    config: dict

def _config_path_for_key(api_key: str) -> Path:
    key_hash = hashlib.sha256(api_key.encode()).hexdigest()[:24]
    return CONFIG_DIR / f"{key_hash}.json"

@router.get("/config")
def get_config(api_key: str = ""):
    if not api_key:
        raise HTTPException(status_code=422, detail="api_key requerido")
    path = _config_path_for_key(api_key)
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}

@router.post("/config")
def save_config(body: ConfigBody):
    api_key = body.config.get("api_key", "")
    if not api_key:
        raise HTTPException(status_code=422, detail="api_key requerido en config")
    path = _config_path_for_key(api_key)
    path.write_text(json.dumps(body.config, ensure_ascii=False), encoding="utf-8")
    return {"ok": True}

# ── Calibración referencias ──────────────────────────────────────────────────

@router.get("/calibrar-voz/referencias")
def estado_referencias(voice_id: str, model_id: str):
    """Devuelve el estado de las referencias de calibración para una voz."""
    data = _load_calib(voice_id, model_id)
    if data:
        points = data.get("points", [])
        whisper_ready = any("sils_per_sec" in p for p in points)
        return {
            "calibrated":    whisper_ready,   # True solo si tiene el formato nuevo (Whisper)
            "needs_regen":   not whisper_ready,
            "points_count":  len(points),
            "has_pauses":    bool(data.get("natural_pauses")),
            "generated_at":  data.get("generated_at"),
        }
    return {"calibrated": False, "needs_regen": False, "points_count": 0,
            "has_pauses": False, "generated_at": None}

# ────────────────────────────────────────────────────────────────────────────


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

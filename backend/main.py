"""
Meditation Audio Studio — FastAPI Backend
App principal: monta los routers de cada módulo.
"""

from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routers import guiones
from routers import auth
from routers import admin
from routers import bucles
from routers import generador
import torchaudio
if not hasattr(torchaudio, 'AudioMetaData'):
    from torchaudio.backend.common import AudioMetaData
    torchaudio.AudioMetaData = AudioMetaData
try:
    from routers.guiones import PYDUB_AVAILABLE
except ImportError:
    PYDUB_AVAILABLE = False

try:
    from routers import classifier_router as _classifier_router
    _CLASSIFIER_ROUTER = _classifier_router.router
except Exception:
    _CLASSIFIER_ROUTER = None

try:
    from routers import audiosync_router as _audiosync_router
    _AUDIOSYNC_ROUTER = _audiosync_router.router
except Exception:
    _AUDIOSYNC_ROUTER = None

ALLOWED_ORIGINS = [
    "http://localhost:5173",
    "http://localhost:3000",
    "https://app-studio-frontend.qil8rz.easypanel.host",
    "https://test-agentia.qil8rz.easypanel.host",
]

app = FastAPI(title="Meditation Audio Studio", version="3.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)

# ── Módulos ───────────────────────────────────────────────────
app.include_router(guiones.router)
app.include_router(auth.router)
app.include_router(admin.router)
app.include_router(bucles.router)
app.include_router(generador.router)
if _CLASSIFIER_ROUTER:
    app.include_router(_CLASSIFIER_ROUTER)
if _AUDIOSYNC_ROUTER:
    app.include_router(_AUDIOSYNC_ROUTER)

# ── Health global ─────────────────────────────────────────────
@app.get("/api/health")
def health():
    return {"ok": True, "pydub": PYDUB_AVAILABLE}

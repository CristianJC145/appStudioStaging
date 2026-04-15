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
try:
    from routers.guiones import PYDUB_AVAILABLE
except ImportError:
    PYDUB_AVAILABLE = False

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

# ── Health global ─────────────────────────────────────────────
@app.get("/api/health")
def health():
    return {"ok": True, "pydub": PYDUB_AVAILABLE}

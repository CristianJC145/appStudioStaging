FROM python:3.11-slim

# 1. CRÍTICO: Forzar a Python a enviar los logs a la consola de EasyPanel inmediatamente
ENV PYTHONUNBUFFERED=1

WORKDIR /app

# 2. CRÍTICO: Añadir libgomp1 para que CTranslate2 (WhisperX) pueda ejecutarse
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libsndfile1 \
    git \
    build-essential \
    python3-dev \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .

RUN pip install --upgrade pip setuptools wheel
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN mkdir -p /app/data/voice_calibrations /app/data/configs

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
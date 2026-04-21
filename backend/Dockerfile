FROM python:3.11-slim

WORKDIR /app

# 1. Añadimos herramientas de compilación (build-essential y python3-dev)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libsndfile1 \
    git \
    build-essential \
    python3-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .

# 2. Es CRÍTICO actualizar pip primero para que procese bien la URL de PyTorch
RUN pip install --upgrade pip setuptools wheel
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN mkdir -p /app/data/voice_calibrations /app/data/configs

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
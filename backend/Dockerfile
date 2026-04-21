FROM python:3.11-slim

WORKDIR /app

# Instalar ffmpeg (para pydub/whisper) y libsndfile1 (para librosa)
# Se añade git porque algunas dependencias de WhisperX lo requieren al instalar por pip
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libsndfile1 \
    git \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN mkdir -p /app/data/voice_calibrations /app/data/configs

# (Opcional) Precargar WhisperX. Si usas el modelo 'base', descargará los pesos de PyTorch.
# RUN python -c "import whisperx; whisperx.load_model('base', 'cpu', compute_type='float32')" || true

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
# Cambiamos a Bullseye para recuperar la herramienta execstack
FROM python:3.11-bullseye

ENV PYTHONUNBUFFERED=1

WORKDIR /app

# Instalamos execstack y las dependencias del sistema
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libsndfile1 \
    git \
    build-essential \
    python3-dev \
    libgomp1 \
    execstack \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .

RUN pip install --upgrade pip setuptools wheel
RUN pip install --no-cache-dir -r requirements.txt

# LA CIRUGÍA: Limpiamos la bandera de seguridad que bloquea Docker
RUN find /usr/local/lib/python3.11/site-packages -name "libctranslate2*.so*" -exec execstack -c {} +

COPY . .

RUN mkdir -p /app/data/voice_calibrations /app/data/configs

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1

WORKDIR /app

# 1. Instalar dependencias base y la herramienta wget
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libsndfile1 \
    git \
    build-essential \
    python3-dev \
    libgomp1 \
    wget \
    pkg-config \
    libavformat-dev \
    libavcodec-dev \
    libavdevice-dev \
    libavutil-dev \
    libswscale-dev \
    libswresample-dev \
    libavfilter-dev \
    && rm -rf /var/lib/apt/lists/*

# 2. EL HACK DEVOPS: Descargar execstack del archivo histórico de Debian
RUN wget http://archive.debian.org/debian/pool/main/p/prelink/execstack_0.0.20131005mac-1.1_amd64.deb \
    && dpkg -i execstack_0.0.20131005mac-1.1_amd64.deb \
    && rm execstack_*.deb

COPY requirements.txt .

# 3. Instalar dependencias de Python
RUN pip install --upgrade pip setuptools wheel
RUN pip install --no-cache-dir -r requirements.txt

# 4. LA CIRUGÍA: Curar CTranslate2 del error "Executable Stack"
RUN find /usr/local/lib/python3.11/site-packages -name "libctranslate2*.so*" -exec execstack -c {} +

COPY . .

RUN mkdir -p /app/data/voice_calibrations /app/data/configs

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
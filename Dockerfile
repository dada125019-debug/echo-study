FROM node:22-bookworm-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONUTF8=1 \
    PYTHONIOENCODING=utf-8 \
    PYTHON_BIN=/opt/venv/bin/python \
    HOST=0.0.0.0 \
    PORT=4173 \
    NODE_ENV=production \
    ARGOS_PACKAGES_DIR=/app/.argos-packages \
    ARGOS_CHUNK_TYPE=MINISBD \
    XDG_CONFIG_HOME=/app/.argos-config \
    XDG_DATA_HOME=/app/.argos-data \
    XDG_CACHE_HOME=/app/.argos-cache \
    HF_HOME=/app/.cache/huggingface

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv ffmpeg libgomp1 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/venv

WORKDIR /app
COPY requirements.txt ./
RUN /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

COPY . .
RUN mkdir -p media-cache .argos-packages .argos-config .argos-data .argos-cache .cache/huggingface \
    && /opt/venv/bin/python scripts/install_models.py \
    && chown -R node:node /app

USER node
EXPOSE 4173
CMD ["node", "server.js"]

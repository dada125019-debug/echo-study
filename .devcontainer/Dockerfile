FROM node:22-bookworm-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONUTF8=1 \
    PYTHONIOENCODING=utf-8 \
    PYTHON_BIN=/opt/venv/bin/python \
    HOST=0.0.0.0 \
    PORT=7860 \
    NODE_ENV=production \
    ARGOS_PACKAGES_DIR=/workspaces/.echo-study/argos-packages \
    ARGOS_CHUNK_TYPE=MINISBD \
    XDG_CONFIG_HOME=/workspaces/.echo-study/config \
    XDG_DATA_HOME=/workspaces/.echo-study/data \
    XDG_CACHE_HOME=/workspaces/.echo-study/cache \
    HF_HOME=/workspaces/.echo-study/huggingface

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv ffmpeg libgomp1 ca-certificates git openssh-client \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/venv

COPY requirements.txt /tmp/echo-study-requirements.txt
RUN /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/venv/bin/pip install --no-cache-dir -r /tmp/echo-study-requirements.txt

USER node

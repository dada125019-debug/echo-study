#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[1/6] Installing FFmpeg and system libraries..."
for YARN_SOURCE in /etc/apt/sources.list.d/yarn.list /etc/apt/sources.list.d/yarn.sources; do
  if [[ -f "$YARN_SOURCE" ]]; then
    sudo mv -f "$YARN_SOURCE" "$YARN_SOURCE.disabled"
  fi
done
sudo apt-get update -qq
sudo apt-get install -y -qq ffmpeg libgomp1 python3-venv curl openssl

echo "[2/6] Preparing Python environment..."
if [[ ! -x .venv/bin/python ]]; then
  python3 -m venv .venv
fi
.venv/bin/python -m pip install --quiet --upgrade pip
.venv/bin/python -m pip install --quiet -r requirements.txt

echo "[3/6] Preparing anonymous YouTube access..."
mkdir -p .codespace-runtime media-cache
POT_ROOT="$ROOT_DIR/.codespace-runtime/bgutil-ytdlp-pot-provider"
if [[ ! -f "$POT_ROOT/server/build/main.js" ]]; then
  rm -rf "$POT_ROOT"
  git clone --quiet --depth 1 --single-branch --branch 1.3.1 \
    https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git "$POT_ROOT"
  (
    cd "$POT_ROOT/server"
    npm ci --silent
    npx tsc
  )
fi

if [[ -f .codespace-runtime/pot-provider.pid ]]; then
  OLD_POT_PID="$(cat .codespace-runtime/pot-provider.pid)"
  if kill -0 "$OLD_POT_PID" 2>/dev/null; then
    kill "$OLD_POT_PID"
  fi
fi
nohup node "$POT_ROOT/server/build/main.js" \
  > .codespace-runtime/pot-provider.log 2>&1 &
POT_PID=$!
echo "$POT_PID" > .codespace-runtime/pot-provider.pid
sleep 2
if ! kill -0 "$POT_PID" 2>/dev/null; then
  echo "Anonymous YouTube provider failed to start. Recent log output:" >&2
  tail -n 40 .codespace-runtime/pot-provider.log >&2
  exit 1
fi

echo "[4/6] Configuring login..."
read -r -s -p "Enter website password: " APP_PASSWORD_VALUE
echo
if [[ -z "$APP_PASSWORD_VALUE" ]]; then
  echo "Password cannot be empty." >&2
  exit 1
fi

if [[ -f .codespace-runtime/server.pid ]]; then
  OLD_PID="$(cat .codespace-runtime/server.pid)"
  if kill -0 "$OLD_PID" 2>/dev/null; then
    kill "$OLD_PID"
  fi
fi

echo "[5/6] Starting Echo Study..."
nohup env \
  APP_USERNAME=111 \
  APP_PASSWORD="$APP_PASSWORD_VALUE" \
  SESSION_SECRET="$(openssl rand -hex 32)" \
  PYTHON_BIN="$ROOT_DIR/.venv/bin/python" \
  HOST=0.0.0.0 \
  PORT=7860 \
  NODE_ENV=production \
  node server.js > .codespace-runtime/server.log 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > .codespace-runtime/server.pid
unset APP_PASSWORD_VALUE

for _ in $(seq 1 30); do
  if curl --silent --fail http://127.0.0.1:7860/api/health >/dev/null; then
    break
  fi
  sleep 1
done

if ! curl --silent --fail http://127.0.0.1:7860/api/health >/dev/null; then
  echo "Server failed to start. Recent log output:" >&2
  tail -n 40 .codespace-runtime/server.log >&2
  exit 1
fi

echo "[6/6] Publishing port 7860..."
if command -v gh >/dev/null 2>&1 && [[ -n "${CODESPACE_NAME:-}" ]]; then
  gh codespace ports visibility 7860:public -c "$CODESPACE_NAME" || true
  gh codespace ports -c "$CODESPACE_NAME" || true
fi

echo "Echo Study is running successfully on port 7860."

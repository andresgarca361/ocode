#!/usr/bin/env bash
set -e
PROXY_DIR="$(cd "$(dirname "$0")" && pwd)"
PROXY_PORT="${PROXY_PORT:-18080}"

if [ -f "$PROXY_DIR/proxy.pid" ]; then
  OLD_PID=$(cat "$PROXY_DIR/proxy.pid")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[proxy] stopping existing proxy (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 1
  fi
fi

echo "[proxy] starting opencode universal proxy on port $PROXY_PORT..."
CERT_FILE="/Users/30andgarcia/homebrew/etc/ca-certificates/cert.pem"
if [ -f "$CERT_FILE" ]; then
  export NODE_EXTRA_CA_CERTS="$CERT_FILE"
fi
PROXY_PORT="$PROXY_PORT" nohup node "$PROXY_DIR/proxy.mjs" > "$PROXY_DIR/proxy.log" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PROXY_DIR/proxy.pid"
echo "[proxy] started (PID $NEW_PID)"

sleep 3
if kill -0 "$NEW_PID" 2>/dev/null; then
  echo "[proxy] running - http://127.0.0.1:$PROXY_PORT"
  echo "[proxy] models: http://127.0.0.1:$PROXY_PORT/v1/models"
  echo "[proxy] providers: http://127.0.0.1:$PROXY_PORT/v1/providers"
  echo "[proxy] health: http://127.0.0.1:$PROXY_PORT/health"
else
  echo "[proxy] FAILED to start. Check $PROXY_DIR/proxy.log"
  exit 1
fi

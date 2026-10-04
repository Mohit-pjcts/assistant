#!/usr/bin/env bash
# One command for everything: Stage's panel and local API (http://127.0.0.1:3000) and the overlay (menu bar), together.
#   bash scripts/start.sh            normal: the overlay never appears in screenshots or screen recordings
#   bash scripts/start.sh --record   recording a demo: cursors, widgets and drawings show up in screen recordings
# Ctrl+C stops both. Running it again first stops a Stage that is already running (only Stage: whatever else might be
# listening on the port is left alone, and the start fails loudly instead).
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.bun/bin:$PATH"
PORT="${PORT:-3000}"
REC=""; [[ "${1:-}" == "--record" ]] && REC="--record"
APP="overlay/build/Stage Overlay.app"
BIN="$APP/Contents/MacOS/StageOverlay"
SERVER_FILE="${STAGE_SERVER_FILE:-$HOME/Library/Application Support/Stage/server.json}"

# stop an older Stage (its pid is in the server file) and its overlay
if [[ -f "$SERVER_FILE" ]]; then
  OLD=$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$SERVER_FILE")
  if [[ -n "$OLD" ]] && ps -p "$OLD" -o command= 2>/dev/null | grep -q "src/main.ts"; then kill "$OLD" 2>/dev/null || true; fi
fi
pkill -f "Stage Overlay.app/Contents/MacOS/StageOverlay" 2>/dev/null || true
for _ in $(seq 1 50); do lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 0.1; done

# build the overlay only if it's missing or older than its source (a rebuild is a new app to macOS unless signed)
if [[ ! -x "$BIN" || overlay/Overlay.swift -nt "$BIN" ]]; then
  bash scripts/build-overlay.sh
fi

stop() { pkill -f "Stage Overlay.app/Contents/MacOS/StageOverlay" 2>/dev/null; kill "$PANEL" 2>/dev/null; exit 0; }
trap stop INT TERM

rm -f "$SERVER_FILE"
OVERLAY=off PORT="$PORT" bun run src/main.ts &
PANEL=$!
# wait for THIS server to be up (it writes the server file once it listens), not a fixed sleep
for _ in $(seq 1 100); do
  [[ -f "$SERVER_FILE" ]] && grep -q "\"pid\":$PANEL" "$SERVER_FILE" && break
  kill -0 "$PANEL" 2>/dev/null || { echo "Stage didn't start (see above)"; exit 1; }
  sleep 0.1
done
open -g "$APP" --args --port "$PORT" $REC
[[ -n "$REC" ]] && echo "recording mode: the overlay shows up in screen recordings"
echo "Ctrl+C stops Stage and the overlay"
wait "$PANEL"
stop

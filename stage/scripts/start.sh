#!/usr/bin/env bash
# One command for everything: Stage's panel and local API (http://127.0.0.1:3000) and the overlay (menu bar), together.
#   bash scripts/start.sh            normal: the overlay never appears in screenshots or screen recordings
#   bash scripts/start.sh --record   recording a demo: cursors, widgets and drawings show up in screen recordings
# It also starts the Cua Driver daemon (scripts/daemon.sh). Ctrl+C stops all three. Running it again first stops a Stage that is already running (only Stage: whatever else might be
# listening on the port is left alone, and the start fails loudly instead).
set -uo pipefail
cd "$(dirname "$0")/.."
# ~/.local/bin is where cua-driver lives; an app launched from Spotlight/Dock does not have it on its PATH
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
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

# The Cua Driver daemon Stage's agents act through: started with Stage, stopped with it, so it is never started by hand.
# daemon.sh restarts it with our tuning (and so also replaces one left over from a crashed run). It runs in the
# background because it waits up to 20 s for a permission grant, which must not hold up the panel.
if [[ "${STAGE_NO_CUA_DAEMON:-}" == "" ]]; then
  bash scripts/daemon.sh >/dev/null 2>&1 &
fi

stop_cua() { cua-driver stop >/dev/null 2>&1; pkill -f 'CuaDriver.app/Contents/MacOS/cua-driver' 2>/dev/null; }
stop() { pkill -f "Stage Overlay.app/Contents/MacOS/StageOverlay" 2>/dev/null; stop_cua; kill "$PANEL" 2>/dev/null; exit 0; }
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

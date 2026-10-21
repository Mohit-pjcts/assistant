#!/bin/sh
# Runs OniCore's Mac client against the REAL Python routes (assistant/server.py)
# with a SCRIPTED graph in place of the model (Scripts/serve_temp_mac.py): real
# SSE framing, real detached turns, real stores on throwaway databases, no API
# key read, no money spent. Needs the project venv (../../../.venv).
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
SERVER_PID=""
STATE="$(mktemp -d)"
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; rm -rf "$STATE"; true; }
trap cleanup EXIT INT TERM

PORT="$("$ROOT/.venv/bin/python" -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')"
(cd "$ROOT" && ONI_MAC_STATE_DIR="$STATE" exec "$ROOT/.venv/bin/python" "$HERE/serve_temp_mac.py" "$PORT") &
SERVER_PID=$!

i=0
until curl -fsS "http://127.0.0.1:$PORT/memory/pending" >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -gt 120 ] && { echo "backend did not start" >&2; exit 1; }
    sleep 0.5
done
echo "scripted Mac backend up on :$PORT"

ONI_TEST_MAC_URL="http://127.0.0.1:$PORT" "$HERE/../test.sh" --filter MacBackend "$@"

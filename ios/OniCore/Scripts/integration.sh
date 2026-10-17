#!/bin/sh
# Runs OniCore's sync engine against the REAL Python /vault API, serving a temp
# COPY of the real Vault (default ~/Documents/OniVault). The real Vault and the
# real .vault_token are never touched. Needs the project venv (../../../.venv).
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
SRC="${ONI_REAL_VAULT:-$HOME/Documents/OniVault}"
TMP="$(mktemp -d)"
SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT INT TERM

cp -R "$SRC" "$TMP/OniVault"
TOKEN="integration-$(date +%s)-$$"
printf '%s\n' "$TOKEN" > "$TMP/token"
PORT="$("$ROOT/.venv/bin/python" -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')"

(cd "$ROOT" && exec "$ROOT/.venv/bin/python" "$HERE/serve_temp_vault.py" "$TMP/OniVault" "$TMP/token" "$PORT") &
SERVER_PID=$!

i=0
until curl -fsS -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/vault/ping" >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -gt 60 ] && { echo "backend did not start" >&2; exit 1; }
    sleep 0.5
done
echo "backend up on :$PORT serving a copy of $SRC"

ONI_TEST_BASE_URL="http://127.0.0.1:$PORT" ONI_TEST_TOKEN="$TOKEN" ONI_TEST_VAULT_DIR="$TMP/OniVault" \
    "$HERE/../test.sh" "$@"

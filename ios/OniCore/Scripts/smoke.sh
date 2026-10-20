#!/bin/sh
# One real conversation with the on-device Oni's engine against the live Anthropic
# API (Haiku, then Sonnet): answer from a note, save one, refuse to delete a note
# that isn't Oni's. SPENDS REAL MONEY (a few cents). Notes live in a temp folder;
# the real Vault is never touched. The key is read from the repo's .env into the
# test process only and is never printed.
set -e
cd "$(dirname "$0")/.."
KEY=$(grep '^ANTHROPIC_API_KEY=' ../../.env | head -1 | cut -d= -f2- | tr -d "\"' ")
[ -n "$KEY" ] || { echo "No ANTHROPIC_API_KEY in ../../.env" >&2; exit 1; }
ONI_SMOKE_ANTHROPIC_KEY="$KEY" exec ./test.sh --filter SmokeRealAPI "$@"

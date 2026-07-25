#!/bin/bash
# Launched by /Applications/Oni.app (an AppleScript wrapper, not a compiled
# Tauri binary — see that app's own Info.plist comment / STEPS.md for why).
# Opening this way instead of a `tauri build` release bundle is the
# deliberate trade-off requested directly: a real app icon that always
# reflects live source changes, at the cost of a visible Terminal window
# (this IS `npm run tauri dev`, just launched by double-click instead of
# by typing the command — same process, same live reload, same backend/
# voice-daemon child-process lifecycle as running it by hand).
cd "$(dirname "$0")"

# "Every update should live-update to all three [desktop app, phone/PWA,
# backend]" — the desktop window already gets this for free from Tauri's
# own Vite HMR (npm run tauri dev, below). The other two needed real
# fixes, not just this script:
#   - Phone/PWA: reads dashboard/dist/ as a static build (server.py's
#     static mount — the phone isn't on the Vite dev server, see that
#     mount's own docstring for why), which previously only updated on a
#     manual `npm run build`. `build:watch` (package.json) keeps it
#     continuously fresh in the background instead — the phone still
#     needs an actual page refresh to see a new build (there's no
#     network-HMR to a phone browser), but the build itself is never
#     stale by more than a few seconds.
#   - Backend: assistant/server.py's `--reload --reload-dir assistant`
#     (src-tauri/src/lib.rs's spawn_backend) now auto-restarts uvicorn on
#     a Python change — covers the desktop window and the phone/PWA path
#     identically, since both talk to this ONE backend process.
npm run build:watch &
BUILD_WATCH_PID=$!
trap 'kill "$BUILD_WATCH_PID" 2>/dev/null' EXIT

npm run tauri dev

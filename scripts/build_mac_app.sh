#!/bin/bash
# Build Oni.app signed with a stable identity, so macOS keeps the permissions
# you granted it (Full Disk Access, Automation, Photos, ...) across rebuilds.
#
# An ad-hoc signature (Tauri's default) is a hash of the exact build, so every
# rebuild looked like a new app to macOS and dropped its grants. A signature
# from a certificate has a requirement that stays the same between builds.
#
# Identity: the first "Apple Development" certificate in your keychain (the
# free one Xcode makes when you sign in to your Apple ID), or set
# APPLE_SIGNING_IDENTITY to a certificate name or SHA-1 yourself. It is looked
# up here rather than written in tauri.conf.json so no personal details are
# committed.
set -euo pipefail

cd "$(dirname "$0")/../dashboard"

if [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then
  APPLE_SIGNING_IDENTITY=$(security find-identity -v -p codesigning \
    | awk '/Apple Development/ {print $2; exit}')
fi
if [ -z "$APPLE_SIGNING_IDENTITY" ]; then
  echo "No code-signing identity found. Open Xcode > Settings > Accounts, add your" >&2
  echo "Apple ID, and create an Apple Development certificate; or set APPLE_SIGNING_IDENTITY." >&2
  exit 1
fi
export APPLE_SIGNING_IDENTITY

npm run tauri -- build --bundles app

APP="src-tauri/target/release/bundle/macos/Oni.app"
codesign --verify --deep --strict "$APP"
echo "Built $APP"
codesign -dr - "$APP" 2>&1 | grep designated
echo "Quit Oni, then copy it to /Applications (ditto \"$APP\" /Applications/Oni.app) and reopen."

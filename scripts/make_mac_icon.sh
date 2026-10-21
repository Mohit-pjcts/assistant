#!/bin/sh
# Builds the Mac app icon from Oni's SVG mark and regenerates the Tauri icon set.
#
# ios/Scripts/oni-app-icon.svg is rendered by macOS's own SVG renderer, shrunk
# into the standard macOS icon shape (an 824 px rounded square, 184 px corners,
# centred on a transparent 1024 px canvas), and handed to `tauri icon`, which writes
# every size into dashboard/src-tauri/icons. The previous icons were the Tauri logo.
#
#     sh scripts/make_mac_icon.sh
set -e
root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
qlmanage -t -s 1024 -o "$work" "$root/ios/Scripts/oni-app-icon.svg" >/dev/null 2>&1
python3 - "$work" <<'PY'
import sys
from PIL import Image, ImageDraw
work = sys.argv[1]
body = Image.open(f"{work}/oni-app-icon.svg.png").convert("RGB").resize((824, 824), Image.LANCZOS)
mask = Image.new("L", (824 * 4, 824 * 4), 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, 824 * 4 - 1, 824 * 4 - 1), radius=184 * 4, fill=255)
mask = mask.resize((824, 824), Image.LANCZOS)
canvas = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
canvas.paste(body, (100, 100), mask)
canvas.save(f"{work}/mac-icon-1024.png")
PY
cd "$root/dashboard"
./node_modules/.bin/tauri icon "$work/mac-icon-1024.png"
# `tauri icon` also writes Android/iOS sets and a 64x64 this desktop app never uses.
rm -rf src-tauri/icons/android src-tauri/icons/ios src-tauri/icons/64x64.png
rm -rf "$work"

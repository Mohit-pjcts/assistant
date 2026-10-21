#!/bin/sh
# Renders scripts/oni-app-icon.svg into the 1024 px PNG the asset catalog needs
# (macOS's own SVG renderer, no extra tools), flattened to opaque RGB as app
# icons must be. Run from anywhere: sh ios/scripts/make_app_icon.sh
set -e
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
qlmanage -t -s 1024 -o "$work" "$here/oni-app-icon.svg" >/dev/null 2>&1
python3 -c "
from PIL import Image
im = Image.open('$work/oni-app-icon.svg.png').convert('RGB')
assert im.size == (1024, 1024), im.size
im.save('$here/../Oni/Assets.xcassets/AppIcon.appiconset/icon-1024.png')
"
rm -rf "$work"
echo "wrote Oni/Assets.xcassets/AppIcon.appiconset/icon-1024.png"

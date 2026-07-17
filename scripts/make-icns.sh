#!/bin/zsh
# build/icon-1024.png → build/icon.icns, with macOS's own tools (sips + iconutil).
set -e
cd "$(dirname "$0")/.."
SRC=build/icon-1024.png
SET=build/icon.iconset
rm -rf "$SET"; mkdir -p "$SET"
for s in 16 32 128 256 512; do
  sips -z $s $s      "$SRC" --out "$SET/icon_${s}x${s}.png"      >/dev/null
  sips -z $((s*2)) $((s*2)) "$SRC" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$SET" -o build/icon.icns
rm -rf "$SET"
echo "→ build/icon.icns"

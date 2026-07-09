#!/bin/bash
# Rebuild the 1280x800 MIM desktop wallpaper from the source image and wordmark.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

EARTH="${1:-$HOME/Desktop/img/earth.jpg}"
WORDMARK="${2:-$REPO_DIR/assets/mim-ultra-wordmark-white.svg}"
OUT="${3:-$REPO_DIR/assets/wallpaper.png}"

if ! command -v magick >/dev/null 2>&1; then
  echo "magick is required" >&2
  exit 1
fi

if [ ! -f "$EARTH" ]; then
  echo "missing earth source: $EARTH" >&2
  exit 1
fi

if [ ! -f "$WORDMARK" ]; then
  echo "missing wordmark source: $WORDMARK" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT")"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

CANVAS_W=1280
CANVAS_H=800
EARTH_W=1510
EARTH_CENTER_X=704
EARTH_CENTER_Y=496
EARTH_ROTATION=-44
DISK_CENTER_X=750
DISK_CENTER_Y=344
DISK_RADIUS=532
WORDMARK_W=224
WORDMARK_X=1016
WORDMARK_Y=718

magick "$EARTH" \
  -resize "${EARTH_W}x" \
  -colorspace sRGB \
  -modulate 72,72,100 \
  -black-threshold 2% \
  "$TMP_DIR/earth-base.png"

read EARTH_BASE_W EARTH_BASE_H < <(
  magick identify -format "%w %h\n" "$TMP_DIR/earth-base.png"
)

magick -size "${EARTH_BASE_W}x${EARTH_BASE_H}" xc:black \
  -fill white \
  -draw "circle ${DISK_CENTER_X},${DISK_CENTER_Y} ${DISK_CENTER_X},$((DISK_CENTER_Y + DISK_RADIUS))" \
  -blur 0x8 \
  -level 45%,55% \
  "$TMP_DIR/disk-mask.png"

magick "$TMP_DIR/earth-base.png" "$TMP_DIR/disk-mask.png" \
  -alpha off \
  -compose CopyOpacity \
  -composite \
  "$TMP_DIR/earth-masked.png"

magick "$TMP_DIR/earth-masked.png" \
  -background none \
  -rotate "$EARTH_ROTATION" \
  "$TMP_DIR/earth-rotated.png"

read EARTH_ROTATED_W EARTH_ROTATED_H < <(
  magick identify -format "%w %h\n" "$TMP_DIR/earth-rotated.png"
)

EARTH_X=$((EARTH_CENTER_X - EARTH_ROTATED_W / 2))
EARTH_Y=$((EARTH_CENTER_Y - EARTH_ROTATED_H / 2))

magick -background none "$WORDMARK" \
  -resize "${WORDMARK_W}x" \
  "$TMP_DIR/wordmark.png"

magick -size "${CANVAS_W}x${CANVAS_H}" xc:black \
  "$TMP_DIR/earth-rotated.png" \
  -geometry +"$EARTH_X"+"$EARTH_Y" \
  -composite \
  "$TMP_DIR/wordmark.png" \
  -geometry +"$WORDMARK_X"+"$WORDMARK_Y" \
  -composite \
  "$OUT"

echo "wrote $OUT"

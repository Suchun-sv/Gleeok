#!/usr/bin/env bash
# Rebuild app/assets/ from a square render of the icon (needs ImageMagick 7 and node):
#   dev/make-icons.sh <render.png> <tile size> <tile offset> <corner radius>
# The numbers locate the rounded tile inside the render; for the original (1254px Codex render,
# tile 1088px at +83+83 after trimming its edge, radius 236): dev/make-icons.sh render.png 1088 83 236
set -euo pipefail
src=$(realpath "$1"); size=$2; off=$3; radius=$4
cd "$(dirname "$0")/../app/assets"
# Cut the tile out of Codex's render (a few px inside its edge), round the corners, and place it
# on Apple's icon grid: an 832px tile centred on a transparent 1024px canvas.
magick "$src" -crop ${size}x${size}+$off+$off +repage \
  \( -size ${size}x${size} xc:none -fill white -draw "roundrectangle 0,0,$((size - 1)),$((size - 1)),$radius,$radius" \) \
  -alpha set -compose DstIn -composite -compose Over \
  -filter Lanczos -resize 832x832 -background none -gravity center -extent 1024x1024 icon.png
for s in 16 32 64 128 256 512; do magick icon.png -filter Lanczos -resize ${s}x${s} icon-$s.png; done
magick icon.png -define icon:auto-resize=256,128,64,48,32,16 icon.ico
node - <<'JS'
// .icns: 'icns' + total length, then per entry a type, its length (incl. 8-byte header) and a PNG.
const fs = require('fs');
const entries = [['icp4', 'icon-16.png'], ['icp5', 'icon-32.png'], ['ic07', 'icon-128.png'], ['ic08', 'icon-256.png'],
  ['ic09', 'icon-512.png'], ['ic10', 'icon.png'], ['ic11', 'icon-32.png'], ['ic12', 'icon-64.png'], ['ic13', 'icon-256.png'], ['ic14', 'icon-512.png']];
const parts = entries.map(([type, file]) => {
  const data = fs.readFileSync(file);
  const head = Buffer.alloc(8);
  head.write(type, 0, 'ascii');
  head.writeUInt32BE(data.length + 8, 4);
  return Buffer.concat([head, data]);
});
const body = Buffer.concat(parts);
const head = Buffer.alloc(8);
head.write('icns', 0, 'ascii');
head.writeUInt32BE(body.length + 8, 4);
fs.writeFileSync('icon.icns', Buffer.concat([head, body]));
JS
# Only these are used; the other sizes went into the .icns.
rm -f icon-16.png icon-32.png icon-128.png icon-256.png

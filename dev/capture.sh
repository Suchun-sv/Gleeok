#!/usr/bin/env bash
# Run a dev script headlessly (no display needed) and composite the captures.
#   dev/capture.sh dev/smoke.json /tmp/gleeok-cap
set -euo pipefail
script=$(realpath "$1"); out=${2:-/tmp/gleeok-cap}
profile=${GLEEOK_PROFILE:-/tmp/gleeok-capture-profile}
rm -rf "$out" /tmp/gleeok-capture-downloads; [ -n "${KEEP_PROFILE:-}" ] || rm -rf "$profile"; mkdir -p "$out" /tmp/gleeok-capture-downloads
cd "$(dirname "$0")/../app"
GLEEOK_DEV_SCRIPT=$script GLEEOK_DEV_OUT=$out GLEEOK_USER_DATA=$profile GLEEOK_DOWNLOADS=/tmp/gleeok-capture-downloads \
  timeout 120 "$(node -e 'console.log(require("electron"))' | tail -n1)" . --ozone-platform=headless --ozone-override-screen-size=1600,1000 --disable-gpu 2>&1 | grep -E '\[devscript\]|rror' || true
for j in $(ls "$out"/*.json); do
  name=$(basename "$j" .json)
  args=$(node -e '
    const l = require(process.argv[1]);
    console.log(l.map((x, i) => i === 0 ? process.argv[2] + "/" + x.file : `( ${process.argv[2]}/${x.file} ) -geometry +${x.x}+${x.y} -composite`).join(" "));
  ' "$j" "$out")
  magick $args "$out/$name.png"
done
ls "$out"/*.png | grep -vE -- '-(shell|v[0-9])\.png$'

#!/usr/bin/env bash
# Record the README's animations. demo.webp: three scenes (读论文 / 写论文 / 做实验), the notes
# pane popped out to a second screen, then switching scenes; keyframes from dev/readme-demo.json,
# motion drawn by dev/readme-demo.py. clip-{reader,planner,library}.webp: real input recorded frame
# by frame (dev/readme-clips.json), the pointer drawn by dev/readme-clip.py. Headless, fresh
# profiles, demo data.
# The chat and Overleaf panes need public links (share links work without logging in):
#   CHAT_READ=https://claude.ai/share/… CHAT_WRITE=https://chatgpt.com/share/… \
#   CHAT_EXP=https://claude.ai/share/… OVERLEAF=https://www.overleaf.com/read/… dev/readme-demo.sh
# Needs what dev/capture.sh needs, plus ffmpeg and uv. KEYFRAMES_ONLY=1 stops after the captures.
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
out=${OUT:-/tmp/readme-demo}
: "${CHAT_READ:=https://chatgpt.com/}" "${CHAT_WRITE:=https://chatgpt.com/}" "${CHAT_EXP:=https://chatgpt.com/}"
: "${OVERLEAF:=https://www.overleaf.com/latex/templates}"
mkdir -p /tmp/papers
[ -s /tmp/papers/rag.pdf ] || curl -sL -o /tmp/papers/rag.pdf https://arxiv.org/pdf/2005.11401
[ -s /tmp/papers/attention.pdf ] || curl -sL -o /tmp/papers/attention.pdf https://arxiv.org/pdf/1706.03762
rm -rf /tmp/rag-baseline && cp -r "$repo/dev/demo/rag-baseline" /tmp/rag-baseline
script=$(mktemp --suffix=.json)
trap 'rm -f "$script"' EXIT
links() {
  sed -e "s|@REPO@|$repo|g" -e "s|@CHAT_READ@|$CHAT_READ|g" -e "s|@CHAT_WRITE@|$CHAT_WRITE|g" \
    -e "s|@CHAT_EXP@|$CHAT_EXP|g" -e "s|@OVERLEAF@|$OVERLEAF|g" "$1" >"$script"
}

export SHELL=$repo/dev/demo-shell.sh GLEEOK_CLIENT_CONFIG=/nonexistent GLEEOK_AUTHOR_NAME=我
webp() { ffmpeg -loglevel error -y -framerate "$1" -i "$2/%04d.png" -c:v libwebp_anim -quality 72 -compression_level 6 -loop 0 "$3"; }

links "$repo/dev/readme-demo.json"
"$repo/dev/capture.sh" "$script" "$out" | tee "$out.log"
[ -n "${KEYFRAMES_ONLY:-}" ] && exit 0
uv run --quiet --with pillow python "$repo/dev/readme-demo.py" "$out" "$out.log" "$out/frames"
webp 25 "$out/frames" "$repo/docs/screenshots/demo.webp"

links "$repo/dev/readme-clips.json"
CAPTURE_TIMEOUT=400 "$repo/dev/capture.sh" "$script" "$out-clips"
for clip in reader planner library; do
  uv run --quiet --with pillow python "$repo/dev/readme-clip.py" "$out-clips/clip-$clip" "$out-clips/frames-$clip" 1200
  webp 15 "$out-clips/frames-$clip" "$repo/docs/screenshots/clip-$clip.webp"
done
ls -la "$repo"/docs/screenshots/*.webp

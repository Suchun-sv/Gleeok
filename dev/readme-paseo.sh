#!/usr/bin/env bash
# Record docs/screenshots/clip-paseo.webp: import two Paseo projects in Settings → Paseo, open one,
# start it, and its agent's conversation shows in the AI pane. Uses a throwaway Paseo daemon
# (home /tmp/paseo-demo, port 6799, hostname lab-server via a user namespace) with demo projects,
# never the machine's own daemon; its three agents are real (Claude Haiku, a few thousand tokens
# each) and made once. Needs what dev/readme-demo.sh needs, plus paseo, claude and unshare.
#   dev/readme-paseo.sh            KEEP_DAEMON=1 leaves the demo daemon running afterwards
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
H=/tmp/paseo-demo R=/tmp/paseo-demo-repos out=${OUT:-/tmp/readme-paseo}
: "${CHAT_READ:=https://chatgpt.com/}" "${CHAT_WRITE:=https://chatgpt.com/}" "${CHAT_EXP:=https://chatgpt.com/}"
: "${OVERLEAF:=https://www.overleaf.com/latex/templates}"

repo_demo() {
  mkdir -p "$R/$1" && git -C "$R/$1" init -q && printf '%s\n' "$2" >"$R/$1/README.md"
  git -C "$R/$1" add . && git -C "$R/$1" -c user.name=demo -c user.email=demo@example.com commit -qm init
}
if [ ! -d "$R" ]; then
  repo_demo rag-reproduction '# RAG reproduction

Reproduce RAG-Sequence and RAG-Token (Lewis et al., 2020) on Natural Questions. DPR retriever over a Wikipedia index, BART-large generator. Goal: match the paper EM within 1 point.'
  repo_demo thesis '# Thesis

Chapter drafts for a thesis on retrieval-augmented language models: background, a survey of retrieval methods, and experiments on long-context QA.'
  repo_demo ds4d-lecture '# DS4D lecture: seeing embeddings

Slides and a web demo for a lecture on embedding visualisation with CLIP: similarity, nearest neighbours and 2-D projections.'
fi
mkdir -p "$H"
cat >"$H/config.json" <<'JSON'
{
 "version": 1,
 "daemon": { "listen": "127.0.0.1:6799", "cors": { "allowedOrigins": ["https://app.paseo.sh"] }, "relay": { "enabled": true } },
 "app": { "baseUrl": "https://app.paseo.sh" },
 "features": { "dictation": { "enabled": false }, "voiceMode": { "enabled": false } }
}
JSON
if ! curl -sf http://127.0.0.1:6799/api/status >/dev/null; then
  # Its own hostname, so the recording never shows this machine's.
  (setsid nohup unshare -Ur --uts sh -c "hostname lab-server && SHELL=$repo/dev/demo-shell.sh exec paseo daemon run --home $H" >/tmp/paseo-demo.log 2>&1 </dev/null &)
  for _ in $(seq 30); do curl -sf http://127.0.0.1:6799/api/status >/dev/null && break; sleep 1; done
fi
if ! paseo ls --home "$H" -q | grep -q .; then
  agent() { paseo run --home "$H" --provider claude --model claude-haiku-4-5-20251001 --cwd "$R/$1" --title "$2" --wait-timeout 4m "$3" >/dev/null; }
  agent rag-reproduction 复现步骤 '读一下 README，列出复现 RAG-Sequence 的三个主要步骤，每步一两句话。只回答，不要修改任何文件。'
  agent thesis 第二章提纲 '根据 README，给第二章（检索方法综述）列一个五小节的提纲，每节一句说明。只回答，不要修改任何文件。'
  agent ds4d-lecture 课堂提问 '根据 README，为这节课设计三个课堂小问题，附简短答案。只回答，不要修改任何文件。'
fi
pair=$(paseo daemon pair --home "$H" | grep -o 'https://app.paseo.sh[^ ]*' | head -1)

script=$(mktemp --suffix=.json)
trap 'rm -f "$script"; [ -n "${KEEP_DAEMON:-}" ] || paseo daemon stop --home "$H" >/dev/null 2>&1 || true' EXIT
sed -e "s|@PAIR@|$pair|g" -e "s|@CHAT_READ@|$CHAT_READ|g" -e "s|@CHAT_WRITE@|$CHAT_WRITE|g" \
  -e "s|@CHAT_EXP@|$CHAT_EXP|g" -e "s|@OVERLEAF@|$OVERLEAF|g" "$repo/dev/readme-paseo.json" >"$script"
PASEO_URL=http://127.0.0.1:6799 GLEEOK_CLIENT_CONFIG=/nonexistent GLEEOK_AUTHOR_NAME=我 CAPTURE_TIMEOUT=200 \
  "$repo/dev/capture.sh" "$script" "$out"
uv run --quiet --with pillow python "$repo/dev/readme-clip.py" "$out/clip-paseo" "$out/frames" 1200
ffmpeg -loglevel error -y -framerate 15 -i "$out/frames/%04d.png" -c:v libwebp_anim -quality 72 -compression_level 6 -loop 0 "$repo/docs/screenshots/clip-paseo.webp"
ls -la "$repo/docs/screenshots/clip-paseo.webp"

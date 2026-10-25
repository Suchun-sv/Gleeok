#!/usr/bin/env bash
# Retake the README's screenshots (docs/screenshots/) from demo data, headless, with a fresh profile:
# public pages, two arXiv papers, made-up tasks, weather pinned to a public city, and the shown
# clock set to a weekday morning (dev/readme-screenshots.json). Run where dev/capture.sh runs.
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p /tmp/papers
[ -s /tmp/papers/rag.pdf ] || curl -sL -o /tmp/papers/rag.pdf https://arxiv.org/pdf/2005.11401
[ -s /tmp/papers/attention.pdf ] || curl -sL -o /tmp/papers/attention.pdf https://arxiv.org/pdf/1706.03762
GLEEOK_CLIENT_CONFIG=/nonexistent "$repo/dev/capture.sh" "$repo/dev/readme-screenshots.json" /tmp/readme-shots >/dev/null
for f in 01-workspace 02-newtab 03-planner 04-library 05-agent; do cp "/tmp/readme-shots/${f}__main.png" "$repo/docs/screenshots/$f.png"; done
ls -la "$repo/docs/screenshots"

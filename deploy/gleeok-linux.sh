#!/usr/bin/env bash
# Launch Gleeok from the checkout on a Wayland desktop (niri). Install:
#   ln -sf ~/github/gleeok/deploy/gleeok-linux.sh ~/.local/bin/gleeok
#   cp ~/github/gleeok/deploy/gleeok.desktop ~/.local/share/applications/
# Rebuild after pulling changes: (cd ~/github/gleeok/app && npm run build)
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/../app"
# The first call downloads Electron and prints a progress line before the path: keep the last line.
electron=$(node -e 'console.log(require("electron"))' | tail -n1)
# --enable-wayland-ime + text-input v3: lets fcitx5 type Chinese into pages on niri.
exec "$electron" . --ozone-platform=wayland --enable-wayland-ime --wayland-text-input-version=3 "$@"

#!/usr/bin/env bash
# Give this checkout's Electron (castLabs' build, with Widevine) a production VMP signature from
# castLabs' free EVS service, so DRM services that refuse a development signature on macOS (Apple
# Music full tracks, …) play in Gleeok. Run once from Terminal:
#
#   deploy/macos-vmp-sign.sh            sign (the first time it creates a free EVS account)
#   deploy/macos-vmp-sign.sh --reauth   sign, logging in to an EVS account you already have
#
# Gleeok's in-app update runs it again with --if-needed after npm installs a new Electron (which
# arrives without the signature); that does nothing unless this machine was signed before.
# VMP signing has to come before code signing on macOS, so the app is re-signed (ad hoc) after it;
# the first launch afterwards may ask once for keychain access ("Always Allow").
set -euo pipefail

mode=${1:-}
repo=$(cd "$(dirname "$0")/.." && pwd)
dist="$repo/app/node_modules/electron/dist"
venv="$HOME/.local/share/gleeok/evs-venv"
marker="$HOME/.config/gleeok/vmp-signed"
say() { [ "$mode" = --if-needed ] || echo "$@"; }

[ "$(uname)" = Darwin ] || { echo "only needed on macOS (Linux has no VMP)"; exit 0; }
[ -d "$dist/Electron.app" ] || { echo "no Electron in $dist: run 'npm install' in $repo/app first" >&2; exit 1; }
version=$(node -p "require('$repo/app/node_modules/electron/package.json').version")

if [ "$mode" = --if-needed ]; then
  # Never signed on this machine: the user has not opted in, leave it alone.
  [ -f "$marker" ] || exit 0
  [ "$(cat "$marker")" = "$version" ] && exit 0
fi

# castLabs' EVS client, in a virtualenv of its own (Homebrew's Python refuses global installs).
if [ ! -x "$venv/bin/python" ]; then
  say "Setting up the castLabs EVS client in $venv…"
  python3 -m venv "$venv"
fi
"$venv/bin/python" -m pip install --quiet --upgrade castlabs-evs
evs() { "$venv/bin/python" -m "$@"; }

if [ "$mode" = --reauth ]; then
  evs castlabs_evs.account reauth
elif [ "$mode" != --if-needed ] && [ ! -f "$marker" ]; then
  echo "EVS needs a (free) castLabs account. Sign up now; if you already have one, press Ctrl+C and"
  echo "run: deploy/macos-vmp-sign.sh --reauth"
  evs castlabs_evs.account signup
fi

say "VMP-signing Electron $version…"
if [ "$mode" = --if-needed ]; then
  # No prompts from the in-app update: an expired login fails here and Gleeok says so.
  evs castlabs_evs.vmp sign-pkg "$dist" </dev/null
else
  evs castlabs_evs.vmp sign-pkg "$dist"
fi

say "Re-signing the app (ad hoc)…"
codesign --force --deep --sign - "$dist/Electron.app"

evs castlabs_evs.vmp verify-pkg "$dist" >/dev/null
mkdir -p "$(dirname "$marker")"
echo "$version" >"$marker"
say "Done: Electron $version has a production VMP signature. Restart Gleeok."

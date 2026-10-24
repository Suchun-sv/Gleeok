#!/usr/bin/env bash
# For Gleeok run from this checkout on a Mac: make the Electron it runs (castLabs' build, with
# Widevine) look like Gleeok, and give it a production VMP signature from castLabs' free EVS
# service, so DRM services that refuse a development signature on macOS (Apple Music full tracks,
# …) play in Gleeok. Run once from Terminal:
#
#   deploy/macos-vmp-sign.sh            name + sign (the first time it creates a free EVS account)
#   deploy/macos-vmp-sign.sh --reauth   the same, logging in to an EVS account you already have
#   deploy/macos-vmp-sign.sh --name-only   only the name and icon (no EVS)
#
# Gleeok's in-app update runs it with --if-needed after npm installs a new Electron (which arrives
# as "Electron", unsigned): that renames it again, and signs it again if this machine signed before.
# VMP signing has to come before code signing on macOS, so the app is re-signed (ad hoc) last; the
# first launch afterwards may ask once for keychain access ("Always Allow").
set -euo pipefail

mode=${1:-}
repo=$(cd "$(dirname "$0")/.." && pwd)
dist="$repo/app/node_modules/electron/dist"
bundle="$dist/Electron.app"
venv="$HOME/.local/share/gleeok/evs-venv"
marker="$HOME/.config/gleeok/vmp-signed"
say() { [ "$mode" = --if-needed ] || echo "$@"; }

[ "$(uname)" = Darwin ] || { echo "only needed on macOS"; exit 0; }
[ -d "$bundle" ] || { echo "no Electron in $dist: run 'npm install' in $repo/app first" >&2; exit 1; }
version=$(node -p "require('$repo/app/node_modules/electron/package.json').version")

# The menu bar and the Dock take the app's name from its Info.plist: call it Gleeok, with its icon.
renamed=0
plist="$bundle/Contents/Info.plist"
for key in CFBundleName CFBundleDisplayName; do
  if [ "$(plutil -extract "$key" raw -o - "$plist" 2>/dev/null || true)" != Gleeok ]; then
    plutil -replace "$key" -string Gleeok "$plist"
    renamed=1
  fi
done
if ! cmp -s "$repo/app/assets/icon.icns" "$bundle/Contents/Resources/electron.icns"; then
  cp "$repo/app/assets/icon.icns" "$bundle/Contents/Resources/electron.icns"
  renamed=1
fi
[ $renamed = 1 ] && say "Named the app Gleeok (menu bar, Dock)."

# Sign by hand always; from an update only if this machine signed before and the bundle changed.
sign=0
case "$mode" in
  --name-only) ;;
  --if-needed) [ -f "$marker" ] && { [ "$(cat "$marker")" != "$version" ] || [ $renamed = 1 ]; } && sign=1 ;;
  *) sign=1 ;;
esac

if [ $sign = 1 ]; then
  # castLabs' EVS client, in a virtualenv of its own (Homebrew's Python refuses global installs).
  if [ ! -x "$venv/bin/python" ]; then
    say "Setting up the castLabs EVS client in $venv…"
    python3 -m venv "$venv"
  fi
  "$venv/bin/python" -m pip install --quiet --upgrade castlabs-evs
  evs() { "$venv/bin/python" -m "$@"; }

  if [ "$mode" = --reauth ]; then
    evs castlabs_evs.account reauth
  elif [ -z "$mode" ] && [ ! -f "$marker" ]; then
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
fi

# Renaming or VMP-signing breaks the bundle's code signature: sign it again, ad hoc.
if [ $renamed = 1 ] || [ $sign = 1 ]; then
  say "Re-signing the app (ad hoc)…"
  codesign --force --deep --sign - "$bundle"
fi

if [ $sign = 1 ]; then
  "$venv/bin/python" -m castlabs_evs.vmp verify-pkg "$dist" >/dev/null
  mkdir -p "$(dirname "$marker")"
  echo "$version" >"$marker"
  say "Done: Electron $version is named Gleeok and has a production VMP signature. Restart Gleeok."
elif [ $renamed = 1 ]; then
  say "Done. Restart Gleeok."
else
  say "Nothing to do."
fi

#!/usr/bin/env bash
# Create ~/Applications/Gleeok.app, which starts Gleeok from this checkout: open it from
# Spotlight (Cmd+Space "Gleeok"), Launchpad, or keep it in the Dock. Run from Terminal, so the
# launcher records this shell's PATH (apps started from the Dock do not get it, and Gleeok needs
# node, plus git and npm for in-app updates). Re-run after moving the checkout or changing how
# Node is installed.
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
command -v node >/dev/null || { echo "node not found on PATH" >&2; exit 1; }
[ -d "$repo/app/node_modules" ] || { echo "run 'npm install && npm run build' in $repo/app first" >&2; exit 1; }

app=~/Applications/Gleeok.app
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"

icon="$repo/app/assets/icon.icns"
[ -f "$icon" ] && cp "$icon" "$app/Contents/Resources/gleeok.icns"

cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Gleeok</string>
  <key>CFBundleDisplayName</key><string>Gleeok</string>
  <key>CFBundleIdentifier</key><string>dev.gleeok.launcher</string>
  <key>CFBundleExecutable</key><string>gleeok</string>
  <key>CFBundleIconFile</key><string>gleeok</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
</dict>
</plist>
PLIST

cat > "$app/Contents/MacOS/gleeok" <<SCRIPT
#!/bin/bash
export PATH=$(printf '%q' "$PATH")
cd $(printf '%q' "$repo/app")
# The first run of a fresh install prints a download line before the path: keep the last line.
electron=\$(node -e 'console.log(require("electron"))' | tail -n1)
exec "\$electron" .
SCRIPT
chmod +x "$app/Contents/MacOS/gleeok"

echo "Created $app — open it with Cmd+Space \"Gleeok\", or drag it to the Dock."

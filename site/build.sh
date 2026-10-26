#!/usr/bin/env bash
# Assemble the GitHub Pages site into $1 (default _site): the page, the README's animations, the
# icon, and the latest release's version filled into the download links.
#   site/build.sh [out] [version]   (version defaults to the latest GitHub release, e.g. v0.1.2)
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-$repo/_site}
version=${2:-$(curl -fsSL https://api.github.com/repos/Suchun-sv/Gleeok/releases/latest | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p')}
rm -rf "$out" && mkdir -p "$out/media"
cp "$repo"/site/{style.css,main.js,og.png} "$out/"
cp "$repo"/docs/screenshots/*.webp "$repo/app/assets/icon-64.png" "$out/media/"
sed -e "s/{{VERSION}}/$version/g" -e "s/{{VNUM}}/${version#v}/g" "$repo/site/index.html" >"$out/index.html"
echo "site for $version in $out"

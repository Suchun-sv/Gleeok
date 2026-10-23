#!/usr/bin/env bash
# Build Zotero's PDF reader (https://github.com/zotero/reader, AGPL-3.0) into
# app/vendor/zotero-reader/, which Gleeok ships and loads for 文献库 PDFs (see docs/library.md).
#   dev/build-reader.sh [reader commit]
# Needs git, Node and about a minute. To update the reader: change READER_COMMIT (and
# LOCALE_COMMIT to the one in the reader's .zotero-locale-commit), run this, commit the result.
set -euo pipefail
READER_COMMIT=${1:-4bfd82ee848e36e80aaff2a2c732615c89ad1e72}
# Zotero commit whose translations the reader was built against (its .zotero-locale-commit).
LOCALE_COMMIT=a6a919234a360f5cc0f8dbf45b84e1fafc546f41
LOCALES=(zh-CN)

repo=$(cd "$(dirname "$0")/.." && pwd)
out=$repo/app/vendor/zotero-reader
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

git -C "$work" init -q reader
cd "$work/reader"
git remote add origin https://github.com/zotero/reader
git fetch -q --depth 1 origin "$READER_COMMIT"
git checkout -q FETCH_HEAD
git submodule update -q --init --recursive --depth 1
NODE_OPTIONS=--openssl-legacy-provider npm install --no-fund --no-audit --loglevel=error
NODE_OPTIONS=--openssl-legacy-provider npm run build > build.log 2>&1 || { tail -30 build.log; exit 1; }

rm -rf "$out"
mkdir -p "$out/locales/en-US"
cp -r build/web/. "$out/"
cp COPYING "$out/LICENSE"
# English first, then each translation on top (later bundles override earlier ones, so missing
# strings fall back to English).
cp locales/en-US/*.ftl "$out/locales/en-US/"
for l in "${LOCALES[@]}"; do
  mkdir -p "$out/locales/$l"
  for f in zotero.ftl reader.ftl; do
    curl -fsSL "https://raw.githubusercontent.com/zotero/zotero/$LOCALE_COMMIT/chrome/locale/$l/zotero/$f" -o "$out/locales/$l/$f"
  done
done
cat > "$out/SOURCE.md" <<EOF
# Zotero reader (vendored)

Built by \`dev/build-reader.sh\` from https://github.com/zotero/reader at commit
\`$READER_COMMIT\` (submodules: $(git submodule status --recursive | awk '{print $2 "@" substr($1, 1, 12)}' | tr '\n' ' ')),
with translations from https://github.com/zotero/zotero at \`$LOCALE_COMMIT\`.

Copyright © Corporation for Digital Scholarship. Licensed under the GNU Affero General Public
License v3 (see LICENSE); the corresponding source is the commits above, unmodified.
EOF
echo "built $(du -sh "$out" | cut -f1) into $out"

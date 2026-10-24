#!/usr/bin/env bash
# One-time: make the self-signed code-signing certificate release builds sign the macOS app with, and
# store it as the repository's MAC_CERT_P12 / MAC_CERT_PASSWORD secrets (needs gh, logged in).
#
# Why: without a stable identity every release is a different app to macOS, and the keychain asks
# again for "Gleeok Safe Storage" (the key to saved logins) after each update. It is not an Apple
# developer identity: Gatekeeper still blocks the first open of a download, as for ad hoc builds.
# Keep it: a new certificate means one more keychain prompt for everyone on the next update.
set -euo pipefail

repo=${1:-Suchun-sv/Gleeok}
NAME="Gleeok Self-Signed"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

cat >"$tmp/cert.cnf" <<EOF
[req]
distinguished_name = dn
prompt = no
[dn]
CN = $NAME
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
EOF

openssl req -x509 -newkey rsa:2048 -nodes -days 7300 \
  -keyout "$tmp/key.pem" -out "$tmp/cert.pem" -config "$tmp/cert.cnf" -extensions ext 2>/dev/null
password=$(openssl rand -hex 24)
# -legacy (OpenSSL 3): the PKCS#12 encryption macOS's `security import` understands.
legacy=$(openssl version | grep -q '^OpenSSL 3' && echo -legacy || true)
openssl pkcs12 -export $legacy -inkey "$tmp/key.pem" -in "$tmp/cert.pem" -name "$NAME" \
  -out "$tmp/id.p12" -passout "pass:$password"

base64 <"$tmp/id.p12" | tr -d '\n' | gh secret set MAC_CERT_P12 -R "$repo"
printf '%s' "$password" | gh secret set MAC_CERT_PASSWORD -R "$repo"
echo "Set MAC_CERT_P12 and MAC_CERT_PASSWORD on $repo (certificate \"$NAME\", valid 20 years)."

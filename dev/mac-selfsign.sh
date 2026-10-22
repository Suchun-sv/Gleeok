#!/usr/bin/env bash
# One-time, on the Mac: create the "Gleeok Self-Signed" code-signing identity in the login keychain.
#
# Why: an unsigned or ad-hoc-signed build gets a new code identity on every rebuild, so macOS treats
# each build as a different app — the keychain prompt for "gleeok Safe Storage" (the key that
# encrypts cookies, i.e. your logins) comes back, and a denial silently loses saved logins.
# Signing every build with the same certificate keeps that trust across rebuilds.
set -euo pipefail

NAME="Gleeok Self-Signed"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-identity -v -p codesigning | grep -q "\"$NAME\""; then
  echo "identity already present:"
  security find-identity -v -p codesigning | grep "\"$NAME\""
  exit 0
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

cat > "$tmp/cert.cnf" <<EOF
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

# /usr/bin/openssl is LibreSSL; its PKCS#12 output is what `security import` expects
# (Homebrew OpenSSL 3 would need -legacy).
/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$tmp/key.pem" -out "$tmp/cert.pem" -config "$tmp/cert.cnf" -extensions ext
/usr/bin/openssl pkcs12 -export -inkey "$tmp/key.pem" -in "$tmp/cert.pem" \
  -name "$NAME" -out "$tmp/id.p12" -passout pass:gleeok

security import "$tmp/id.p12" -k "$KEYCHAIN" -P gleeok -T /usr/bin/codesign -T /usr/bin/security
echo "macOS will now ask for your login password to trust the certificate for code signing."
security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$tmp/cert.pem"

security find-identity -v -p codesigning | grep "\"$NAME\""

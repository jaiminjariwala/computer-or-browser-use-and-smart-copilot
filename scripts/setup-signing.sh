#!/usr/bin/env bash
#
# One-time setup: create a STABLE self-signed code-signing identity for Glass.
#
# Why: Glass is normally ad-hoc signed, whose fingerprint changes on every
# build, so macOS forgets the Screen Recording permission after each rebuild.
# Signing every build with this fixed identity keeps the fingerprint stable, so
# you grant Screen Recording ONCE and it persists across all future rebuilds.
#
# Run this once:  bash scripts/setup-signing.sh
# It will ask for your Mac login password once (to trust the certificate).

set -euo pipefail

CN="Glass Local Signing"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-identity -v -p codesigning 2>/dev/null | grep -q "$CN"; then
    echo "✅ Signing identity '$CN' already exists. Nothing to do."
    exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "1/4  Generating a self-signed code-signing certificate…"
openssl req -x509 -newkey rsa:2048 -keyout "$TMP/glass.key" -out "$TMP/glass.crt" \
    -days 3650 -nodes -subj "/CN=$CN" \
    -addext "keyUsage=critical,digitalSignature" \
    -addext "extendedKeyUsage=critical,codeSigning" >/dev/null 2>&1

echo "2/4  Packaging it (macOS-compatible PKCS#12)…"
openssl pkcs12 -export -legacy -inkey "$TMP/glass.key" -in "$TMP/glass.crt" \
    -out "$TMP/glass.p12" -passout pass:glass >/dev/null 2>&1

echo "3/4  Importing into your login keychain…"
security import "$TMP/glass.p12" -k "$KEYCHAIN" -P glass -T /usr/bin/codesign -A >/dev/null

echo "4/4  Trusting it for code signing (you'll be prompted for your Mac password)…"
security add-trusted-cert -p codeSign -k "$KEYCHAIN" "$TMP/glass.crt"

if security find-identity -v -p codesigning | grep -q "$CN"; then
    echo "✅ Done. Signing identity '$CN' is ready."
    echo "   Future builds signed with it keep the Screen Recording grant."
else
    echo "⚠️  Identity not listed after trust. The trust step may not have applied."
    echo "   Open Keychain Access → login → '$CN' → Trust → Code Signing → Always Trust."
    exit 1
fi

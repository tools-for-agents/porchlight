#!/bin/zsh
# Build hangar, sign it with a STABLE identity, and install it to /Applications.
#
# ── Why this file exists ─────────────────────────────────────────────────────
#
# 🔑 macOS REMEMBERS A PERMISSION BY THE APP'S CODE SIGNATURE, NOT ITS PATH.
#
# Every folder a bay points at under ~/Desktop, ~/Documents or ~/Downloads is
# TCC-protected. The agent in the tile reads it, macOS attributes that read to the
# app that spawned it — hangar — and asks. Once. Then it writes the answer down
# against hangar's *designated requirement*.
#
# electron-builder ships this app with `identity: null`, which does not sign the
# bundle at all: what survives is Electron's raw linker signature, and the whole
# app's identity collapses to
#
#     # designated => cdhash H"233bded3262b0853b5e68fc749e8a4ed9af3f6ed"
#
# A cdhash is a hash of the binary. It changes on EVERY rebuild. So every grant the
# user ever gave is void the moment `npm run dist` runs again, and the next launch
# asks for the Desktop folder again — once per bay, forever. That is the fifty
# dialogs. Nothing about it is Claude's permission prompt; the agent already runs
# with --dangerously-skip-permissions.
#
# Signing with a certificate — even one we made ourselves — changes the requirement to
#
#     identifier "dev.toolsforagents.hangar" and certificate leaf = H"<the cert>"
#
# which is the same string after every rebuild. Grant Full Disk Access once and it
# holds for good. That is the entire point of this script.
#
# The certificate is deliberately NOT in package.json's build config: a developer
# cloning this repo must still be able to run `npm run dist` on a machine that has
# never heard of it. Local signing is a local-machine concern, so it lives here.
#
# Usage:  ./scripts/install-local.sh          build, sign, install
#         ./scripts/install-local.sh --sign   sign + install whatever is in dist/ already
set -e
cd "$(dirname "$0")/.."

CN="hangar-dev-signing"                     # the certificate's common name
APPID="dev.toolsforagents.hangar"           # must match CFBundleIdentifier
APP="dist/mac-arm64/hangar.app"
DEST="/Applications/hangar.app"

# ── 0. Do not kill live agents behind the user's back ────────────────────────
# Replacing the bundle means quitting hangar, and hangar kills every bay on quit.
# Those are real sessions with real work in them. Ask.
RUNNING=$(pgrep -f "hangar.app/Contents/MacOS/hangar" || true)
if [[ -n "$RUNNING" ]]; then
  BAYS=$(pgrep -fc -- "--dangerously-skip-permissions" || echo 0)
  echo "hangar is running with $BAYS agent(s) in it. Installing will quit it and end them."
  printf "continue? [y/N] "
  read -r ans
  [[ "$ans" == (y|Y|yes) ]] || { echo "left alone."; exit 1; }
fi

# ── 1. The certificate ───────────────────────────────────────────────────────
# Made once, kept forever. Delete it and every grant goes with it, so if you ever
# rotate it you will be re-approving Full Disk Access — that is expected.
if ! security find-certificate -c "$CN" >/dev/null 2>&1; then
  echo "▸ creating the signing certificate (one time)…"
  TMP=$(mktemp -d)
  cat > "$TMP/openssl.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = $CN
[v3]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF
  # /usr/bin/openssl (LibreSSL) on purpose: a brew OpenSSL 3 earlier in PATH exports
  # PKCS12 as AES-256/PBKDF2, which `security import` refuses with
  # "MAC verification failed during PKCS12 import (wrong password?)".
  /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 7300 \
    -keyout "$TMP/key.pem" -out "$TMP/cert.pem" -config "$TMP/openssl.cnf" 2>/dev/null
  /usr/bin/openssl pkcs12 -export -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
    -out "$TMP/id.p12" -passout pass:"$CN" -name "$CN" 2>/dev/null

  # -A: codesign may use the key without a keychain dialog every single time.
  echo "  → macOS will ask for your login password (twice: import, then trust)."
  security import "$TMP/id.p12" -k "$HOME/Library/Keychains/login.keychain-db" \
    -P "$CN" -A -T /usr/bin/codesign -T /usr/bin/security
  # Trust is what makes `security find-identity -v -p codesigning` list it. Signing
  # mostly works without it, so a refusal here is not fatal.
  security add-trusted-cert -r trustRoot -p codeSign \
    -k "$HOME/Library/Keychains/login.keychain-db" "$TMP/cert.pem" || \
    echo "  ! trust step declined — continuing; signing usually still works."
  rm -rf "$TMP"
else
  echo "▸ certificate $CN already in the keychain"
fi

# ── 2. Build ─────────────────────────────────────────────────────────────────
if [[ "$1" != "--sign" ]]; then
  echo "▸ building…"
  npm run dist
fi
[[ -d "$APP" ]] || { echo "no $APP — run without --sign to build first"; exit 1; }

# ── 3. Sign, inside out ──────────────────────────────────────────────────────
# A bundle seals what is under it, so anything nested must be signed BEFORE its
# parent or the parent's seal is stale the moment it is written. No --deep: it is
# deprecated, and being explicit is how you find out which piece failed.
#
# No --options runtime. The hardened runtime forbids the unsigned-JIT and
# library-loading this app depends on, and with a self-signed certificate there is
# nothing to gain from it — it is notarisation's requirement, not TCC's.
sign() { codesign --force --timestamp=none --sign "$CN" "$@" >/dev/null 2>&1 || \
         codesign --force --timestamp=none --sign "$CN" "$@"; }

echo "▸ signing…"
# native code first: node-pty's helper is exec'd directly, and .node files are loaded
find "$APP/Contents/Resources/app.asar.unpacked" \
     \( -name "*.node" -o -name "spawn-helper" \) -type f 2>/dev/null | while read -r f; do
  sign "$f"
done
find "$APP/Contents/Frameworks" -maxdepth 1 -name "*.framework" | while read -r f; do
  sign "$f"
done
find "$APP/Contents/Frameworks" -maxdepth 1 -name "*.app" | while read -r f; do
  sign "$f"
done
# …and the bundle last, with the identifier the Info.plist actually claims. Left to
# itself the linker signature calls this app "Electron", which is not a name any
# permission can be filed under.
sign --identifier "$APPID" "$APP"

# ── 4. Prove the requirement is the stable kind ──────────────────────────────
# older codesign prints "# designated => …", newer (macOS 26) drops the "# "
REQ=$(codesign -d -r- "$APP" 2>/dev/null | sed -nE 's/^(# )?designated => //p')
echo "▸ designated requirement:"
echo "    $REQ"
case "$REQ" in
  *cdhash*) echo "  ! still cdhash-pinned — permissions will NOT survive the next build."; exit 1 ;;
  *"certificate leaf"*) echo "  ✓ stable across rebuilds" ;;
  *) echo "  ! unexpected requirement — check the signature by hand."; exit 1 ;;
esac

# ── 5. Install ───────────────────────────────────────────────────────────────
echo "▸ installing to $DEST…"
osascript -e 'tell application "hangar" to quit' >/dev/null 2>&1 || true
for i in {1..20}; do pgrep -f "hangar.app/Contents/MacOS/hangar" >/dev/null || break; sleep 0.5; done
pkill -f "hangar.app/Contents/MacOS/hangar" >/dev/null 2>&1 || true
rm -rf "$DEST"
cp -R "$APP" "$DEST"
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

cat <<'EOF'

  Installed. One thing left, and it is the thing that stops the dialogs:

    System Settings → Privacy & Security → Full Disk Access → +  →  /Applications/hangar.app

  Full Disk Access supersedes the per-folder Desktop/Documents/Downloads questions,
  and the agents in the bays inherit it from hangar — so it is one switch, not one
  question per folder. Because the app is now signed with a stable certificate, you
  will not be asked again after the next `npm run dist`.

EOF
open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles" 2>/dev/null || true

#!/usr/bin/env bash
# Build, package, sign, and (optionally) upload a stlviewer release artifact.
#
# Usage:
#   scripts/release.sh <version-tag>            # build + sign locally, no upload
#   scripts/release.sh <version-tag> --upload   # also upload to the GH release
#
# Env overrides:
#   RELEASE_SIGNING_KEY  Path to the SSH private key used for signing.
#                        Default: ~/.ssh/id_ed25519
#   RELEASE_PRINCIPAL    Identity baked into the signature; the verifier
#                        passes the same string via `ssh-keygen -Y verify -I`.
#                        Default: release@stlviewer
#   RELEASE_SKIP_BUILD   If set, reuse the existing build under
#                        target/release/bundle/macos/ instead of rebuilding.
#
# Produces in the repo root:
#   stlviewer-<VERSION>-macos-<arch>.app.zip
#   stlviewer-<VERSION>-macos-<arch>.app.zip.sig     (SSH detached signature)
#   stlviewer-<VERSION>-macos-<arch>.app.zip.sha256  (checksum)
#
# Signature verification is sanity-checked locally before upload using the
# pinned `keys/release-signing.pub`.

set -euo pipefail

if [[ "${OSTYPE:-}" != darwin* ]]; then
    echo "release.sh: macOS only for now (got OSTYPE=${OSTYPE:-unknown})" >&2
    exit 1
fi

VERSION="${1:?usage: $0 <version-tag> [--upload]}"
UPLOAD=0
for arg in "${@:2}"; do
    case "$arg" in
        --upload) UPLOAD=1 ;;
        *) echo "release.sh: unknown arg: $arg" >&2; exit 2 ;;
    esac
done

RELEASE_SIGNING_KEY="${RELEASE_SIGNING_KEY:-$HOME/.ssh/id_ed25519}"
RELEASE_PRINCIPAL="${RELEASE_PRINCIPAL:-release@stlviewer}"

if [[ ! -f "$RELEASE_SIGNING_KEY" ]]; then
    echo "release.sh: signing key not found at $RELEASE_SIGNING_KEY" >&2
    exit 3
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PINNED_PUBKEY="keys/release-signing.pub"
if [[ ! -f "$PINNED_PUBKEY" ]]; then
    echo "release.sh: pinned public key missing at $PINNED_PUBKEY" >&2
    exit 4
fi

step() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }

if [[ -z "${RELEASE_SKIP_BUILD:-}" ]]; then
    step "Building release .app"
    bun run tauri build
fi

APP_SOURCE=""
for candidate in \
    "target/release/bundle/macos/stlviewer.app" \
    "src-tauri/target/release/bundle/macos/stlviewer.app"; do
    if [[ -d "$candidate" ]]; then
        APP_SOURCE="$candidate"
        break
    fi
done
if [[ -z "$APP_SOURCE" ]]; then
    echo "release.sh: built stlviewer.app not found under target/release/bundle/macos/" >&2
    exit 5
fi

ARCH=$(uname -m)
BASENAME="stlviewer-${VERSION}-macos-${ARCH}"
ZIP="${BASENAME}.app.zip"
SIG="${ZIP}.sig"
SUMS="${ZIP}.sha256"

step "Packaging ${ZIP}"
rm -f "$ZIP" "$SIG" "$SUMS"
# ditto preserves macOS bundle metadata correctly; plain `zip` mangles
# symlinks and extended attributes inside .app bundles.
ditto -c -k --keepParent "$APP_SOURCE" "$ZIP"

step "Checksumming"
shasum -a 256 "$ZIP" > "$SUMS"
cat "$SUMS"

step "Signing with ${RELEASE_SIGNING_KEY} as ${RELEASE_PRINCIPAL}"
# ssh-keygen writes the signature to <input>.sig.
ssh-keygen -Y sign -f "$RELEASE_SIGNING_KEY" -n file "$ZIP"

step "Sanity-checking signature against pinned $PINNED_PUBKEY"
ALLOWED_SIGNERS=$(mktemp)
trap 'rm -f "$ALLOWED_SIGNERS"' EXIT
echo "${RELEASE_PRINCIPAL} namespaces=\"file\" $(cat "$PINNED_PUBKEY")" \
    > "$ALLOWED_SIGNERS"
ssh-keygen -Y verify -f "$ALLOWED_SIGNERS" -I "$RELEASE_PRINCIPAL" \
    -n file -s "$SIG" < "$ZIP"

step "Artifacts ready"
ls -la "$ZIP" "$SIG" "$SUMS"

if [[ $UPLOAD -eq 1 ]]; then
    step "Uploading to release ${VERSION}"
    gh release upload "$VERSION" "$ZIP" "$SIG" "$SUMS" --clobber
    step "Uploaded"
else
    cat <<MSG

  Skipped upload (no --upload flag).

  To attach these to the GitHub release:
    gh release upload "${VERSION}" \\
      "${ZIP}" "${SIG}" "${SUMS}" --clobber

MSG
fi

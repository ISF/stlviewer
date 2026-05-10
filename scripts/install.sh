#!/usr/bin/env bash
# Build and install stlviewer locally.
#
# Produces:
#   /Applications/stlviewer.app        — GUI bundle (registered with Launch Services)
#   $CLI_BIN_DIR/stlviewer             — terminal shim (`stlviewer file.stl`)
#
# CLI_BIN_DIR defaults to /opt/homebrew/bin on Apple Silicon Homebrew,
# /usr/local/bin elsewhere — override via env var.
#
# Re-run anytime to update an existing install. The script is idempotent.
# Pass --skip-build to reuse the most recent build outputs.

set -euo pipefail

if [[ "${OSTYPE:-}" != darwin* ]]; then
    echo "install.sh: macOS only for now (got OSTYPE=${OSTYPE:-unknown})" >&2
    exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

APP_NAME="stlviewer"
APP_BUNDLE="${APP_NAME}.app"
APP_DEST="/Applications/${APP_BUNDLE}"

if [[ -z "${CLI_BIN_DIR:-}" ]]; then
    if [[ -d /opt/homebrew/bin ]]; then
        CLI_BIN_DIR=/opt/homebrew/bin
    else
        CLI_BIN_DIR=/usr/local/bin
    fi
fi
CLI_DEST="${CLI_BIN_DIR}/${APP_NAME}"

SKIP_BUILD=0
for arg in "$@"; do
    case "$arg" in
        --skip-build) SKIP_BUILD=1 ;;
        -h|--help)
            sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            echo "install.sh: unknown arg: $arg" >&2
            exit 2
            ;;
    esac
done

step() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }

if [[ $SKIP_BUILD -eq 0 ]]; then
    step "Building the macOS .app bundle (release)"
    npm run tauri build

    step "Building the CLI shim (release)"
    cargo build --release --bin "${APP_NAME}"
fi

# Locate the freshly built .app — Tauri's bundler puts it under src-tauri/target.
APP_SOURCE=""
for candidate in \
    "src-tauri/target/release/bundle/macos/${APP_BUNDLE}" \
    "target/release/bundle/macos/${APP_BUNDLE}"; do
    if [[ -d "$candidate" ]]; then
        APP_SOURCE="$candidate"
        break
    fi
done
if [[ -z "$APP_SOURCE" ]]; then
    echo "install.sh: could not locate built ${APP_BUNDLE}" >&2
    exit 3
fi

# Locate the CLI binary — workspace target dir is shared, so cargo puts it at
# target/release/. Tauri's CLI doesn't touch this.
CLI_SOURCE=""
for candidate in \
    "target/release/${APP_NAME}" \
    "src-tauri/target/release/${APP_NAME}"; do
    if [[ -x "$candidate" ]]; then
        CLI_SOURCE="$candidate"
        break
    fi
done
if [[ -z "$CLI_SOURCE" ]]; then
    echo "install.sh: could not locate built CLI shim ${APP_NAME}" >&2
    exit 4
fi

step "Installing ${APP_DEST}"
# Quit any running instance so the bundle can be replaced.
osascript -e "tell application \"${APP_NAME}\" to quit" >/dev/null 2>&1 || true
sleep 0.5
if [[ -d "$APP_DEST" ]]; then
    rm -rf "$APP_DEST"
fi
ditto "$APP_SOURCE" "$APP_DEST"
# Strip the quarantine attribute so unsigned dev builds open without the
# Gatekeeper prompt for the user that just built it.
xattr -dr com.apple.quarantine "$APP_DEST" 2>/dev/null || true

step "Registering with Launch Services"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [[ -x "$LSREGISTER" ]]; then
    "$LSREGISTER" -f "$APP_DEST"
else
    echo "install.sh: lsregister not found at expected path; first launch may need manual open" >&2
fi

step "Installing ${CLI_DEST}"
if [[ ! -d "$CLI_BIN_DIR" ]]; then
    echo "install.sh: ${CLI_BIN_DIR} does not exist — set CLI_BIN_DIR or create the directory" >&2
    exit 5
fi
if [[ -w "$CLI_BIN_DIR" ]]; then
    install -m 0755 "$CLI_SOURCE" "$CLI_DEST"
else
    echo "  (need sudo for ${CLI_BIN_DIR})"
    sudo install -m 0755 "$CLI_SOURCE" "$CLI_DEST"
fi

step "Installed"
cat <<MSG

  GUI:  $APP_DEST
  CLI:  $CLI_DEST

  Try it:
    stlviewer                                # empty window
    stlviewer path/to/model.stl              # open a file
    stlviewer --watch path/to/model.stl      # open + auto-reload on save

MSG

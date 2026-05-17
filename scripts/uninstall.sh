#!/usr/bin/env bash
# Remove a locally installed stlviewer (the .app and the CLI shim).
# Honours the same CLI_BIN_DIR override as install.sh.

set -euo pipefail

if [[ "${OSTYPE:-}" != darwin* ]]; then
    echo "uninstall.sh: macOS only" >&2
    exit 1
fi

APP_NAME="stlviewer"
APP_DEST="/Applications/${APP_NAME}.app"

if [[ -z "${CLI_BIN_DIR:-}" ]]; then
    if [[ -d /opt/homebrew/bin ]]; then
        CLI_BIN_DIR=/opt/homebrew/bin
    else
        CLI_BIN_DIR=/usr/local/bin
    fi
fi
CLI_DEST="${CLI_BIN_DIR}/${APP_NAME}"

step() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }

osascript -e "tell application \"${APP_NAME}\" to quit" >/dev/null 2>&1 || true
sleep 0.5

if [[ -d "$APP_DEST" ]]; then
    step "Removing ${APP_DEST}"
    rm -rf "$APP_DEST"
fi

if [[ -e "$CLI_DEST" ]]; then
    step "Removing ${CLI_DEST}"
    if [[ -w "$CLI_BIN_DIR" ]]; then
        rm -f "$CLI_DEST"
    else
        sudo rm -f "$CLI_DEST"
    fi
fi

# Clean up any shell-completion files install.sh dropped. Each path covered
# matches a corresponding install path; harmless if it isn't there.
for f in \
    /opt/homebrew/share/fish/vendor_completions.d/${APP_NAME}.fish \
    /usr/local/share/fish/vendor_completions.d/${APP_NAME}.fish \
    "${HOME}/.config/fish/completions/${APP_NAME}.fish"; do
    if [[ -e "$f" ]]; then
        step "Removing ${f}"
        if [[ -w "$(dirname "$f")" ]]; then
            rm -f "$f"
        else
            sudo rm -f "$f"
        fi
    fi
done

step "Uninstalled"

#!/bin/sh
# Run on the Linux execution host after deploying pi-app-server.mjs and src/.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
NODE=$(command -v node)
[ "$(uname -s)" = Linux ] || { echo 'Linux user service only' >&2; exit 1; }
[ "$ROOT" = "$HOME/.local/share/pi-desktop" ] || { echo 'Deploy to ~/.local/share/pi-desktop first' >&2; exit 1; }
systemctl --user show-environment >/dev/null
mkdir -p "$HOME/.config/systemd/user"
UNIT="$HOME/.config/systemd/user/pi-desktop-host.service"
[ ! -e "$UNIT" ] || { echo "Already installed: $UNIT; inspect before replacing" >&2; exit 1; }
umask 077
printf '%s\n' '[Unit]' 'Description=pi-codex persistent session owner' '' \
  '[Service]' 'Type=simple' 'UMask=0077' 'RuntimeDirectory=pi-desktop' 'RuntimeDirectoryMode=0700' \
  'Environment=PI_DESKTOP_REMOTE=1' 'Environment=PI_CODING_AGENT_DIR=%h/.pi/agent' \
  'Environment=CODEX_HOME=%h/.pi/codex-app' 'Environment=PI_DESKTOP_SOCKET=%t/pi-desktop/host.sock' \
  "Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin" \
  "ExecStart=$NODE $ROOT/pi-app-server.mjs --serve" 'WorkingDirectory=%h' \
  'Restart=no' 'TimeoutStopSec=10' '' '[Install]' 'WantedBy=default.target' > "$UNIT"
systemctl --user daemon-reload
systemctl --user enable --now pi-desktop-host.service
# Linger must already be enabled by the machine owner for logout survival.
loginctl show-user "$(id -un)" -p Linger
systemctl --user is-active pi-desktop-host.service

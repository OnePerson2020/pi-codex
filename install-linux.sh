#!/bin/sh
# Deploy the pi-codex host on a Linux machine and install its systemd user service:
#
#   curl -fsSL https://raw.githubusercontent.com/OnePerson2020/pi-codex/main/install-linux.sh | sh
#
# Set PI_CODEX_TAG to pin a release. The deployment owns the Pi SDK version the
# macOS bridge accepts for remote hosts, so both sides agree after an update.

set -eu

REPO=OnePerson2020/pi-codex
SDK_VERSION=0.85.1
TARGET=$HOME/.local/share/pi-desktop
UNIT=$HOME/.config/systemd/user/pi-desktop-host.service
TAG=${PI_CODEX_TAG:-}

die() { echo "$1" >&2; exit 1; }

[ "$(uname -s)" = Linux ] || die "install-linux.sh deploys the Linux execution host. On macOS use install.sh."
[ "$(id -u)" != 0 ] || die "Run as the user that should own the Pi config and sessions, not root."
command -v node >/dev/null 2>&1 || die "Node.js 22.19+ is required."
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22||(a===22&&b<19))process.exit(1)' ||
  die "Node.js 22.19+ is required (found $(node -v))."
systemctl --user show-environment >/dev/null 2>&1 || die "A systemd --user session is required."

if [ -z "$TAG" ]; then
  TAG=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest" |
    sed -n 's#.*/tag/##p')
fi
[ -n "$TAG" ] || die "Could not resolve the latest $REPO release."

WORK=$(mktemp -d "${TMPDIR:-/tmp}/pi-codex.XXXXXX")
trap 'rm -rf "$WORK"' EXIT HUP INT TERM

printf 'Deploying pi-codex %s to %s\n' "$TAG" "$TARGET"
curl -fsSL "https://github.com/$REPO/archive/refs/tags/$TAG.tar.gz" | tar -xz -C "$WORK" --strip-components=1
[ -f "$WORK/scripts/install-linux-host.sh" ] || die "Release $TAG is missing scripts/install-linux-host.sh."

mkdir -p "$TARGET/src" "$TARGET/scripts"
install -m 755 "$WORK/pi-app-server.mjs" "$TARGET/pi-app-server.mjs"
install -m 644 "$WORK/package.json" "$TARGET/package.json"
cp -R "$WORK/src/." "$TARGET/src/"
install -m 755 "$WORK/scripts/install-linux-host.sh" "$TARGET/scripts/install-linux-host.sh"

if [ ! -d "$TARGET/sdk/node_modules/@earendil-works/pi-coding-agent" ]; then
  command -v npm >/dev/null 2>&1 ||
    die "Install npm, install Pi yourself, or set PI_PACKAGE_DIR to an existing Pi package root."
  printf 'Installing the Pi SDK %s into the deployment\n' "$SDK_VERSION"
  # The bridge loads the SDK and its pi-ai dependency from inside the package
  # root, so the SDK must not hoist them to the deployment's node_modules.
  npm install --prefix "$TARGET/sdk" --install-strategy=nested --no-audit --no-fund --loglevel=error \
    "@earendil-works/pi-coding-agent@$SDK_VERSION"
  [ -f "$TARGET/sdk/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js" ] ||
    die "The Pi SDK in $TARGET/sdk has an unusable layout. Set PI_PACKAGE_DIR to another Pi install."
fi

if [ -e "$UNIT" ]; then
  printf '%s\n' \
    "The systemd unit already exists; the deployment files were updated." \
    "Restart it when no remote session is running:" \
    "  systemctl --user restart pi-desktop-host.service"
else
  "$TARGET/scripts/install-linux-host.sh"
fi

loginctl show-user "$(id -un)" -p Linger 2>/dev/null | grep -q 'Linger=yes' ||
  printf 'To keep the host alive after logout: sudo loginctl enable-linger %s\n' "$(id -un)"
printf 'Add the machine in the Codex host picker. Pi credentials on this host live in ~/.pi/agent\n'

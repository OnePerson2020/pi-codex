#!/bin/sh
# Bootstrap installer for the macOS app:
#
#   curl -fsSL https://raw.githubusercontent.com/OnePerson2020/pi-codex/main/install.sh | sh
#
# Downloads the latest release and runs its installer. Flags are forwarded to
# install-mac-app, e.g. `| sh -s -- --mode shared`. Set PI_CODEX_TAG to pin a
# version instead of using the latest release.

set -eu

REPO=OnePerson2020/pi-codex
TAG=${PI_CODEX_TAG:-}

[ "$(uname -s)" = Darwin ] || {
  echo "install.sh installs the macOS app. On a Linux execution host, deploy the checkout and run scripts/install-linux-host.sh." >&2
  exit 1
}

if [ -z "$TAG" ]; then
  TAG=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest" |
    sed -n 's#.*/tag/##p')
fi
[ -n "$TAG" ] || { echo "Could not resolve the latest $REPO release." >&2; exit 1; }

WORK=$(mktemp -d "${TMPDIR:-/tmp}/pi-codex.XXXXXX")
trap 'rm -rf "$WORK"' EXIT HUP INT TERM

printf 'Installing pi-codex %s\n' "$TAG"
curl -fsSL "https://github.com/$REPO/archive/refs/tags/$TAG.tar.gz" |
  tar -xz -C "$WORK" --strip-components=1

[ -x "$WORK/install-mac-app" ] || { echo "Release $TAG is missing install-mac-app." >&2; exit 1; }
"$WORK/install-mac-app" "$@"

#!/bin/sh
# Build a distributable installer DMG:
#
#   ./scripts/package-mac-dmg.sh [output.dmg]
#
# The image carries the bridge payload and a double-clickable installer. It does
# not carry the Codex desktop runtime: the installer copies that runtime from the
# official ChatGPT/Codex app already installed on the target Mac.

set -eu

SELF="$0"
while [ -h "$SELF" ]; do
  DIR=$(cd -P "$(dirname "$SELF")" && pwd)
  SELF=$(readlink "$SELF")
  case "$SELF" in /*) ;; *) SELF="$DIR/$SELF" ;; esac
done
SCRIPT_DIR=$(cd -P "$(dirname "$SELF")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)

VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$REPO_ROOT/package.json")
OUT=${1:-$REPO_ROOT/dist/pi-codex-$VERSION.dmg}
VOLNAME="pi-codex $VERSION"

STAGE=$(mktemp -d "${TMPDIR:-/tmp}/pi-codex-dmg.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT HUP INT TERM

mkdir -p "$STAGE/.payload"
tar -C "$REPO_ROOT" -cf - \
  --exclude ./.git --exclude ./dist --exclude ./docs --exclude ./graft \
  --exclude ./tests --exclude node_modules --exclude .DS_Store . |
  tar -C "$STAGE/.payload" -xf -

cat > "$STAGE/Install pi-codex.command" <<'COMMAND'
#!/bin/sh
# Double-click installer. Flags are forwarded to install-mac-app, so this also
# works from a terminal: ./Install\ pi-codex.command --mode shared
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PAYLOAD="$HERE/.payload"
APP_BUNDLE=${PI_DESKTOP_APP_BUNDLE:-/Applications/pi-codex.app}

[ -x "$PAYLOAD/install-mac-app" ] || {
  echo "The pi-codex payload is missing. Use the disk image itself, not a single copied file." >&2
  exit 1
}

"$PAYLOAD/install-mac-app" "$@"

# Downloaded images carry com.apple.quarantine; the installed app must not.
xattr -cr "$APP_BUNDLE" 2>/dev/null || true
RUNTIME="$(dirname "$APP_BUNDLE")/.$(basename "$APP_BUNDLE").runtime"
[ ! -e "$RUNTIME" ] || xattr -cr "$RUNTIME" 2>/dev/null || true

echo "Launch it with: open -n \"$APP_BUNDLE\""
COMMAND
chmod 755 "$STAGE/Install pi-codex.command"

cat > "$STAGE/README.txt" <<README
pi-codex $VERSION — Codex desktop UI on the Pi agent harness.

BEFORE INSTALLING
  - Node.js 22.19+ and the npm build of @earendil-works/pi-coding-agent
  - An official ChatGPT.app or Codex.app installed in /Applications

INSTALL
  This image is not notarized, so macOS blocks the installer on first use:
  right-click "Install pi-codex.command" and choose Open, then confirm.
  (On recent macOS: System Settings -> Privacy & Security -> Open Anyway.)

  The installer asks between a pinned private runtime (standalone, default) and
  reusing the installed one (shared), then installs pi-codex.app to /Applications.
  A pinned copy needs roughly as much free space as the official app.

  Only the bridge is in this image. The Codex runtime comes from the official
  app already on this Mac and is never redistributed.
README

mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
hdiutil create -volname "$VOLNAME" -srcfolder "$STAGE" -ov -format UDZO "$OUT" >/dev/null
printf 'Built %s (%s)\n' "$OUT" "$(du -h "$OUT" | cut -f1)"

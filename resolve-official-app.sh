#!/bin/sh
# Resolve the official ChatGPT/Codex desktop app bundle and executable.
# Callers source this file, then call resolve_official_app with candidate bundles.

RESOLVED_OFFICIAL_APP=""
RESOLVED_OFFICIAL_APP_BIN=""
RESOLVE_OFFICIAL_APP_ERROR=""

_set_resolve_official_app_error() {
  RESOLVED_OFFICIAL_APP=""
  RESOLVED_OFFICIAL_APP_BIN=""
  RESOLVE_OFFICIAL_APP_ERROR="$1"
  return 1
}

_read_bundle_executable() {
  plist="$1/Contents/Info.plist"
  [ -f "$plist" ] || return 1

  executable=""
  if [ -x /usr/libexec/PlistBuddy ]; then
    executable=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$plist" 2>/dev/null || true)
  fi
  if [ -z "$executable" ]; then
    executable=$(awk '
      /<key>CFBundleExecutable<\/key>/ { found=1; next }
      found && /<string>/ {
        sub(/^.*<string>/, "")
        sub(/<\/string>.*$/, "")
        print
        exit
      }
    ' "$plist" 2>/dev/null || true)
  fi

  [ -n "$executable" ] || return 1
  printf '%s\n' "$executable"
}

_resolve_official_app_bundle() {
  bundle="$1"
  if [ ! -d "$bundle" ]; then
    _set_resolve_official_app_error "Cannot find official ChatGPT/Codex desktop app bundle: $bundle"
    return 1
  fi

  # The app binary is bound by CFBundleExecutable; bundle names are not executable fallbacks.
  executable=$(_read_bundle_executable "$bundle" || true)
  if [ -z "$executable" ]; then
    _set_resolve_official_app_error "Cannot read CFBundleExecutable from $bundle/Contents/Info.plist"
    return 1
  fi

  app_bin="$bundle/Contents/MacOS/$executable"
  if [ ! -x "$app_bin" ]; then
    _set_resolve_official_app_error "Cannot find official ChatGPT/Codex executable: $app_bin"
    return 1
  fi

  RESOLVED_OFFICIAL_APP="$bundle"
  RESOLVED_OFFICIAL_APP_BIN="$app_bin"
  RESOLVE_OFFICIAL_APP_ERROR=""
  return 0
}

_default_official_app_candidates() {
  printf '%s\n' \
    "/Applications/ChatGPT.app" \
    "/Applications/Codex.app" \
    "$HOME/Applications/ChatGPT.app" \
    "$HOME/Applications/Codex.app"
}

resolve_official_app() {
  RESOLVED_OFFICIAL_APP=""
  RESOLVED_OFFICIAL_APP_BIN=""
  RESOLVE_OFFICIAL_APP_ERROR=""

  if [ -n "${CODEX_APP:-}" ]; then
    _resolve_official_app_bundle "$CODEX_APP"
    return $?
  fi

  if [ "$#" -eq 0 ]; then
    set -- \
      "/Applications/ChatGPT.app" \
      "/Applications/Codex.app" \
      "$HOME/Applications/ChatGPT.app" \
      "$HOME/Applications/Codex.app"
  fi

  tried=""
  for candidate in "$@"; do
    tried="${tried}${tried:+, }$candidate"
    if [ -d "$candidate" ]; then
      _resolve_official_app_bundle "$candidate"
      return $?
    fi
  done

  _set_resolve_official_app_error "Cannot find official ChatGPT/Codex desktop app. Tried: $tried. Install ChatGPT.app or Codex.app, or set CODEX_APP to the app bundle path."
}

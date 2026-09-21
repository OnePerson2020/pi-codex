# pi-codex

English | [简体中文](README.zh-CN.md)

Use the Codex desktop UI with the Pi coding agent harness.

Pi still runs the agent. It owns the model providers, agent loop, context and compaction, tools, extensions, skills, MCP servers, subagents, and native session files. The Codex app supplies the desktop interface: projects, session history, streaming responses, tool cards, model controls, and the composer.

```text
Codex desktop app
        ↕ app-server JSON-RPC
     pi-codex
        ↕ Pi SDK
 Pi AgentSession
        ↕
models · tools · extensions · skills · MCP · subagents
```

This split is useful if you like Pi's small, hackable harness and extension ecosystem but want a full desktop UI. The bridge is plain JavaScript, so you can change protocol mappings and agent behavior without forking either Pi or the Codex app.

## What it keeps from Pi

- Pi's native `AgentSession` and JSONL session history
- Existing providers and model configuration
- Built-in and extension tools
- User and project extensions
- Skills, prompt templates, MCP servers, and subagents
- Pi's context management and compaction
- Project-level `.pi` configuration and trust rules

Existing Pi sessions are listed by project and opened in place. They are not imported into a second session format.

## What the Codex UI adds

- Project and session navigation
- Streaming text and reasoning
- Native command and generic tool cards
- Model and reasoning-effort controls
- Stop, steer, compact, fork, archive, and history views
- Pi extension prompts mapped to desktop dialogs
- Optional SSH host routing through the Codex host picker

## Install

### Requirements

- macOS
- Node.js 22.19 or newer
- The npm build of `@earendil-works/pi-coding-agent`
- An installed official `ChatGPT.app` or `Codex.app`

The repository does not contain or redistribute the Codex desktop runtime. The installer uses an app already installed on your Mac.

### Install a release

```bash
curl -fsSL https://raw.githubusercontent.com/OnePerson2020/pi-codex/main/install.sh | sh
open -n "/Applications/pi-codex.app"
```

The bootstrap downloads the [latest release](https://github.com/OnePerson2020/pi-codex/releases/latest) and installs it in `standalone` mode. Use `| sh -s -- --mode shared` to reuse the installed runtime instead, or set `PI_CODEX_TAG=v0.1.0` to pin a version.

### Install from a DMG

Download the `.dmg` from the same release, open it, and right-click `Install pi-codex.command` → Open. The image is not notarized, so macOS asks for that confirmation the first time. The installer asks for the runtime mode and installs `pi-codex.app` into `/Applications`; it removes the download quarantine flag from what it installs. Rebuild the image from a checkout with `./scripts/package-mac-dmg.sh`.

### Install from a checkout

```bash
git clone https://github.com/OnePerson2020/pi-codex.git
cd pi-codex
npm test
./install-mac-app --mode standalone
open -n "/Applications/pi-codex.app"
```

`standalone` copies the installed desktop runtime into a private app-owned location and disables its automatic updates. It does not modify the original app. For local debugging, `--mode shared` reuses the installed runtime directly.

Pi resources continue to load from your normal agent directory, usually `~/.pi/agent`. You do not need to reinstall extensions or skills.

## Linux execution host

Remote projects run on a Linux machine that owns its own Pi config, model credentials, and sessions. Deploy the headless host and its systemd user service there:

```bash
curl -fsSL https://raw.githubusercontent.com/OnePerson2020/pi-codex/main/install-linux.sh | sh
```

The deployment lands in `~/.local/share/pi-desktop` with the Pi SDK version the macOS bridge accepts for remote hosts. It needs Node.js 22.19+ and a `systemd --user` session; `sudo loginctl enable-linger "$USER"` keeps the host alive after logout.

Requires the same release flow as macOS: `PI_CODEX_TAG=v0.1.0` pins a version.

## Run without installing the app

You can exercise the app-server bridge directly:

```bash
printf '%s\n' \
  '{"id":"init","method":"initialize","params":{"clientInfo":{"name":"smoke","version":"1"}}}' \
  '{"id":"models","method":"model/list","params":{}}' |
  ./pi-app-server.mjs
```

## Pi Web session detection

The local bridge can read Pi Web's loopback `/api/sessions` endpoint. When Pi Web explicitly reports a session in `runningSessionIds`, pi-codex labels it `[Pi Web 运行中]`, keeps history readable, and rejects concurrent mutations.

This is occupancy detection, not a distributed lock. If Pi Web is unavailable or its response cannot be matched to the same session file, pi-codex does not block the session. CLI and arbitrary SDK clients are not covered.

Configuration:

```bash
export PI_DESKTOP_PI_WEB_URL=http://127.0.0.1:30141
export PI_DESKTOP_PI_WEB_PASSWORD='your-local-pi-web-password' # only when enabled
```

## Develop your own harness behavior

The main seams are deliberately small:

- `src/pi-host.mjs`: Pi lifecycle and Codex app-server methods
- `src/protocol.mjs`: message, turn, item, model, and tool conversion
- `src/pi-sdk.mjs`: installed Pi SDK discovery
- `src/desktop-mcp.mjs`: Codex desktop tools exposed to Pi
- `src/session-guard.mjs`: local Desktop writer protection
- `src/ssh-transport.mjs`: optional remote host routing

Unknown Pi tools fall back to a generic desktop tool card, so adding an extension usually requires no bridge change. Change the mappings only when you want a more native UI treatment.

Run the offline test suite with:

```bash
PI_OFFLINE=1 PI_TELEMETRY=0 npm test
```

## Safety and current limits

- Pi tools run with the operating-system permissions of the pi-codex process. The Codex UI sandbox selector does not sandbox Pi.
- Concurrent writes from clients that do not participate in the same ownership mechanism can still race.
- TUI-only Pi widgets do not map to a desktop interface.
- The SSH backend requires a separately installed, matching Pi host and SDK on the remote machine.
- The bridge is currently validated against Pi SDK 0.85.1 and a pinned macOS desktop runtime. Upstream protocol changes may require updates.

This project is an independent compatibility bridge. It is not affiliated with or endorsed by OpenAI or the Pi maintainers.

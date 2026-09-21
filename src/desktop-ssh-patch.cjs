'use strict';

// Only two structural edits to the pinned Codex CLI transport. Never rewrite
// auth, tools or session data. Unknown/ambiguous bundles fail closed in SSH mode.
const Module = require('node:module');
const path = require('node:path');
const MARKER = 'pi-desktop-host-routing-v1';
const ORIGINATOR = /(CODEX_INTERNAL_ORIGINATOR_OVERRIDE:([A-Za-z_$][\w$]*)\.defaultOriginator\?\?[A-Za-z_$][\w$]*)/g;
const RECONNECT = /supportsReconnect\(\)\{return this\.kind===`websocket`\}/g;

function transform(content) {
  if (content.includes(MARKER)) return content;
  const originators = [...content.matchAll(ORIGINATOR)];
  const reconnects = [...content.matchAll(RECONNECT)];
  if (originators.length !== 1 || reconnects.length !== 1) {
    throw new Error('pi-codex SSH: unsupported CLI transport bundle; refusing local fallback');
  }
  const routed = content.replace(ORIGINATOR, (full, property, param) => property +
    ',...((function(h){' +
    'if(!h||!["local","ssh"].includes(h.kind))throw Error("pi-codex: unsupported host kind");' +
    'return{PI_DESKTOP_HOST_KIND:h.kind,PI_DESKTOP_SSH_TARGET_JSON:h.kind==="ssh"?' +
    'JSON.stringify(h.ssh_websocket_v0||{}):""};' +
    '})(' + param + '.hostConfig))/* ' + MARKER + ' */');
  return routed.replace(RECONNECT, 'supportsReconnect(){return this.kind===`websocket`||this.options?.hostConfig?.kind===`ssh`}');
}

function install() {
  const original = Module.prototype._compile;
  Module.prototype._compile = function (content, filename) {
    // The pinned UI keeps both CLI spawn and stdio lifecycle in this bundle.
    // A moved/missing bundle cannot silently enable local execution: the
    // app-server separately requires the injected host-kind on every launch.
    if (/^src-.*\.(c?js)$/.test(path.basename(filename)) && filename.includes('app.asar') && content.includes('CODEX_INTERNAL_ORIGINATOR_OVERRIDE:')) {
      content = transform(content);
    }
    return original.call(this, content, filename);
  };
}

if (process.env.PI_DESKTOP_ENABLE_SSH === '1' && process.type === 'browser' && process.versions.electron) install();
module.exports = { transform };

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildSshInvocation, desktopSshTarget, relaySsh, requireRemoteSdkVersion } from "../src/ssh-transport.mjs";
const { transform } = createRequire(import.meta.url)("../src/desktop-ssh-patch.cjs");
const source = 'function spawnEnv(e){return{CODEX_INTERNAL_ORIGINATOR_OVERRIDE:e.defaultOriginator??KH}};class Transport{supportsReconnect(){return this.kind===`websocket`}}';

test("host routing patch isolates local and SSH and rejects missing/ambiguous anchors", () => {
	const patched = transform(source);
	assert.equal(transform(patched), patched);
	const { spawnEnv, Transport } = new Function("KH", patched + ';return {spawnEnv,Transport}')("test");
	const ssh = { kind: "ssh", ssh_websocket_v0: { sshAlias: "devbox", sshHost: "example.invalid" } };
	const remote = spawnEnv({ hostConfig: ssh });
	assert.equal(remote.PI_DESKTOP_HOST_KIND, "ssh");
	assert.equal(JSON.parse(remote.PI_DESKTOP_SSH_TARGET_JSON).sshAlias, "devbox");
	const local = spawnEnv({ hostConfig: { kind: "local" } });
	assert.equal(local.PI_DESKTOP_SSH_TARGET_JSON, "");
	assert.throws(() => spawnEnv({ hostConfig: { kind: "cloud" } }), /unsupported host/);
	const transport = new Transport(); transport.kind = "stdio";
	transport.options = { hostConfig: ssh }; assert.equal(transport.supportsReconnect(), true);
	transport.options = { hostConfig: { kind: "local" } }; assert.equal(transport.supportsReconnect(), false);
	assert.throws(() => transform(source.replace('defaultOriginator', 'renamed')), /refusing local fallback/);
	assert.throws(() => transform(source + source), /refusing local fallback/);
});

test("SSH mode is opt-in and an absent patch never falls back locally", () => {
	assert.equal(desktopSshTarget({}), null);
	assert.equal(desktopSshTarget({ PI_DESKTOP_ENABLE_SSH: '1', PI_DESKTOP_HOST_KIND: 'local' }), null);
	assert.throws(() => desktopSshTarget({ PI_DESKTOP_ENABLE_SSH: '1' }), /did not load/);
	assert.throws(() => desktopSshTarget({ PI_DESKTOP_HOST_KIND: 'ssh' }), /disabled/);
	assert.throws(() => desktopSshTarget({ PI_DESKTOP_ENABLE_SSH: '1', PI_DESKTOP_HOST_KIND: 'ssh', PI_DESKTOP_SSH_TARGET_JSON: 'null' }), /Invalid/);
	assert.deepEqual(desktopSshTarget({ PI_DESKTOP_ENABLE_SSH: '1', PI_DESKTOP_HOST_KIND: 'ssh', PI_DESKTOP_SSH_TARGET_JSON: '{"sshAlias":"devbox"}' }), { sshAlias: 'devbox' });
});

test("SSH reuses alias identity and enforces host verification with no forwarding", () => {
	const { command, args } = buildSshInvocation({ sshAlias: 'devbox', sshPort: 2222, identity: '/ignored/key' }, {});
	assert.equal(command, 'ssh');
	assert.ok(args.includes('StrictHostKeyChecking=yes'));
	assert.ok(args.includes('BatchMode=yes'));
	assert.ok(args.includes('ForwardAgent=no'));
	assert.ok(args.includes('GSSAPIDelegateCredentials=no'));
	assert.ok(args.includes('ClearAllForwardings=yes'));
	assert.equal(args.at(-2), 'devbox');
	assert.equal(args.includes('-p'), false);
	assert.equal(args.includes('-i'), false);
	assert.match(args.at(-1), /exec node/);
	assert.doesNotMatch(args.at(-1), /npm install|auth\.json|scp |curl /);
	const direct = buildSshInvocation({ sshHost: 'user@host', sshPort: 2222, identity: '/tmp/key with spaces' }, {});
	assert.ok(direct.args.includes('/tmp/key with spaces'));
	assert.equal(direct.args.at(-2), 'user@host');
});

test("untrusted host, port, path and shell injection inputs are rejected or quoted", async () => {
	for (const sshHost of ['-oProxyCommand=x', 'host;touch /tmp/oops', 'a\nb', 'a b', '', null]) {
		assert.throws(() => buildSshInvocation({ sshHost }, {}), /Invalid SSH/);
	}
	for (const sshPort of [0, 65536, '22', 1.5]) assert.throws(() => buildSshInvocation({ sshHost: 'host', sshPort }, {}), /port/);
	for (const identity of ['relative', '/', '/tmp/a\nb']) assert.throws(() => buildSshInvocation({ sshHost: 'host', identity }, {}), /identity/);
	for (const custom of ['/', 'relative', '/tmp/a\nb']) assert.throws(() => buildSshInvocation({ sshHost: 'host' }, { PI_DESKTOP_REMOTE_BRIDGE: custom }), /absolute/);
	const built = buildSshInvocation({ sshAlias: 'devbox' }, { PI_DESKTOP_REMOTE_BRIDGE: "/tmp/quote' dollar$ semi; bridge.mjs" });
	await promisify(execFile)('/bin/sh', ['-n', '-c', built.args.at(-1)]);
});

test("remote SDK version fence accepts only the validated version", () => {
	const env = { PI_DESKTOP_REMOTE: '1' };
	assert.throws(() => requireRemoteSdkVersion({}, '0.84.4', env), /requires 0.85.1/);
	assert.throws(() => requireRemoteSdkVersion({}, '0.85.1', env), /missing/);
	requireRemoteSdkVersion({ createAgentSessionFromServices(){} }, '0.85.1', env);
	requireRemoteSdkVersion({}, 'other', {});
});

test("relay preserves Unicode JSONL and drains replies after input EOF", async () => {
	const input = new PassThrough(), output = new PassThrough(), errors = new PassThrough();
	const chunks = []; output.on('data', chunk => chunks.push(chunk));
	let launches = 0;
	const done = relaySsh({ sshAlias: 'devbox' }, { input, output, errorOutput: errors, env: { NODE_OPTIONS: '--invalid' }, spawnChild(command, args, options) {
		launches++; assert.equal(command, 'ssh'); assert.equal(options.env.NODE_OPTIONS, undefined);
		return spawn(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { stdio: ['pipe', 'pipe', 'pipe'] });
	} });
	const request = JSON.stringify({ text: 'hello\u2028世界\u2029', id: 1 }) + '\n';
	input.end(request);
	await done;
	assert.equal(Buffer.concat(chunks).toString(), request);
	assert.equal(launches, 1);
});

test("SSH error never retries and startup is bounded", async () => {
	for (const script of ['process.exit(23)', 'setInterval(()=>{},1000)']) {
		const input = new PassThrough(), output = new PassThrough(), errorOutput = new PassThrough();
		let launches = 0;
		await assert.rejects(relaySsh({ sshAlias: 'devbox' }, { input, output, errorOutput, startupTimeoutMs: 80, env: {}, spawnChild() {
			launches++; return spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
		} }), /exited|timed out/);
		assert.equal(launches, 1);
	}
});

test("patch loader ignores unrelated src bundles and requires the CLI spawn anchor", () => {
	const patchSource = fsSync.readFileSync(new URL('../src/desktop-ssh-patch.cjs', import.meta.url), 'utf8');
	assert.match(patchSource, /content\.includes\('CODEX_INTERNAL_ORIGINATOR_OVERRIDE:'\)/);
});

test("private runtime fuse helper is scoped, idempotent and fails closed", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), '.pi-codex.app.runtime.test-'));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const app = path.join(root, 'Official.app');
	const binary = path.join(app, 'Contents/Frameworks/Codex Framework.framework/Versions/A/Codex Framework');
	await fs.mkdir(path.dirname(binary), { recursive: true });
	await fs.symlink('A', path.join(app, 'Contents/Frameworks/Codex Framework.framework/Versions/Current'));
	const sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
	const fixture = (value) => Buffer.concat([Buffer.from('prefix'), sentinel, Buffer.from([1, 5]), Buffer.from(`00${value}00`), Buffer.from('suffix')]);
	const helper = new URL('../scripts/enable-private-runtime.py', import.meta.url).pathname;
	await fs.writeFile(binary, fixture('0'));
	await promisify(execFile)('python3', [helper, app]);
	assert.equal((await fs.readFile(binary)).subarray(6 + sentinel.length + 2, 6 + sentinel.length + 7).toString(), '00100');
	await promisify(execFile)('python3', [helper, app]);
	const wrongSchema = fixture('0');
	wrongSchema[6 + sentinel.length] = 2;
	await fs.writeFile(binary, wrongSchema);
	await assert.rejects(promisify(execFile)('python3', [helper, app]), /schema/);
	assert.deepEqual(await fs.readFile(binary), wrongSchema);
	await fs.writeFile(binary, fixture('2'));
	await assert.rejects(promisify(execFile)('python3', [helper, app]), /removed/);
	const unsafe = path.join(root, 'Not-Pi.app');
	await fs.mkdir(unsafe);
	await assert.rejects(promisify(execFile)('python3', [helper, unsafe]), /Refusing non-pi-codex private runtime/);
});

test("standalone installer owns the SSH marker and strict signature gate", () => {
	const installer = fsSync.readFileSync(new URL('../install-mac-app', import.meta.url), 'utf8');
	const start = installer.indexOf('if [ "$MODE" = "standalone" ]; then');
	const standalone = installer.slice(start, installer.indexOf('\nfi', start));
	assert.doesNotMatch(installer.slice(0, start), /ssh-enabled/);
	assert.match(standalone, /ssh-enabled/);
	assert.match(standalone, /enable-private-runtime\.py/);
	assert.match(standalone, /codesign --verify --deep --strict/);
	assert.match(installer, /\/Applications\/pi-codex\.app/);
	assert.match(installer, /BRIDGE_RESOURCES="\$RESOURCES\/pi-codex"/);
	assert.match(installer, /mac-app\/pi-codex/);
	for (const module of ["persistent-host", "pi-web-status", "session-guard", "session-liveness"]) {
		assert.match(installer, new RegExp(`^  src/${module}\\.mjs \\\\$`, "m"),
			`installer must validate ${module}.mjs`);
		assert.match(installer, new RegExp(`^install -m 644 .*src/${module}\\.mjs.*$`, "m"),
			`installer must copy ${module}.mjs`);
	}
});

test("Pi SDK lookup supports npm dist/bundle/cli.js without reading a real profile", async (t) => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-ssh-sdk-'));
	t.after(() => fs.rm(dir, { recursive: true, force: true }));
	await fs.mkdir(path.join(dir, 'dist/bundle'), { recursive: true });
	await fs.mkdir(path.join(dir, 'dist/core'), { recursive: true });
	await fs.mkdir(path.join(dir, 'node_modules/@earendil-works/pi-ai/dist'), { recursive: true });
	await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '0.85.1', type: 'module' }));
	await fs.writeFile(path.join(dir, 'dist/bundle/cli.js'), '');
	await fs.writeFile(path.join(dir, 'dist/index.js'), 'export const fixture=true;');
	await fs.writeFile(path.join(dir, 'dist/core/output-guard.js'), 'export const fixture=true;');
	await fs.writeFile(path.join(dir, 'node_modules/@earendil-works/pi-ai/package.json'), '{"type":"module"}');
	await fs.writeFile(path.join(dir, 'node_modules/@earendil-works/pi-ai/dist/index.js'), 'export const Type={};');
	const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
		`import {loadPiSdk} from ${JSON.stringify(new URL('../src/pi-sdk.mjs', import.meta.url).href)}; const sdk=await loadPiSdk(); console.log(JSON.stringify({root:sdk.packageRoot,version:sdk.VERSION,fixture:sdk.fixture}));`],
		{ env: { ...process.env, PI_PACKAGE_DIR: '', PI_BIN: path.join(dir, 'dist/bundle/cli.js') } });
	assert.deepEqual(JSON.parse(stdout), { root: await fs.realpath(dir), version: '0.85.1', fixture: true });
});

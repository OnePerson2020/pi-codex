import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import net from "node:net";
import http from "node:http";
import { PiWebStatus } from "../src/pi-web-status.mjs";
import { once } from "node:events";
import { servePersistentHost } from "../src/persistent-host.mjs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { PiHost } from "../src/pi-host.mjs";
import { loadPiSdk } from "../src/pi-sdk.mjs";
import { entriesToTurns } from "../src/protocol.mjs";
import { ProjectStore } from "../src/project-store.mjs";
import { acquireSessionGuard } from "../src/session-guard.mjs";

async function harness(t, { failTool = false, persistent = false, lazy = false, extensionFactories = [] } = {}) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-desktop-regression-"));
	let cleanupHost;
	t.after(async () => { await cleanupHost?.shutdown(); await fs.rm(directory, { recursive: true, force: true }); });
	const sdk = await loadPiSdk();
	const fauxModule = await import(pathToFileURL(path.join(sdk.packageRoot,
		"node_modules/@earendil-works/pi-ai/dist/providers/faux.js")).href);
	const faux = fauxModule.fauxProvider({ provider: "desktop-test", models: [{
		id: "faux", name: "Faux", reasoning: false, input: ["text"],
		contextWindow: 10000, maxTokens: 1000,
	}] });
	const modelRuntime = await sdk.ModelRuntime.create({ authPath: path.join(directory, "auth.json"), modelsPath: null });
	modelRuntime.registerNativeProvider(faux.provider);
	const sent = [];
	const host = new PiHost({ sdk, cwd: directory, agentDir: directory, codexHome: directory, send(message) {
		sent.push(structuredClone(message));
		if (message.method === "item/tool/call") queueMicrotask(() => host.handle({ id: message.id, result: {
			success: !failTool, contentItems: [{ type: "inputText", text: failTool ? "Desktop refused the operation" : "pong" }],
		} }));
	} });
	host.createServices = (cwd) => sdk.createAgentSessionServices({
		cwd, agentDir: directory, modelRuntime,
		settingsManager: sdk.SettingsManager.inMemory({ defaultProvider: "desktop-test", defaultModel: "faux", retry: { enabled: false } }),
		resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories },
	});
	if (persistent) {
		const sessionDir = path.join(directory, "sessions");
		host.sdk = { ...sdk, SessionManager: class extends sdk.SessionManager {
			static create(cwd) { return super.create(cwd, sessionDir); }
			static forkFrom(file, cwd) { return super.forkFrom(file, cwd, sessionDir); }
			static listAll() { return super.list(directory, sessionDir); }
		} };
	}
	const { thread } = await host.startThread({ cwd: directory, ephemeral: !persistent, model: "desktop-test/faux",
		dynamicTools: [{ name: "desktop_echo", inputSchema: { type: "object", properties: {} } }],
	});
	cleanupHost = host;
	const runtime = lazy ? null : await host.requireThread(thread.id);
	await runtime?.ready;
	return { host, thread, runtime, sent, sdk, directory, faux, ...fauxModule };
}

async function waitForTurn(host, id) {
	const runtime = host.threads.get(id);
	const deadline = Date.now() + 3000;
	while (runtime.activeTurnId) {
		if (Date.now() > deadline) throw new Error("fixture turn did not finish");
		await new Promise(resolve => setTimeout(resolve, 5));
	}
	await runtime.session.waitForIdle();
}

async function runTurn(h, text = "hello") {
	const result = await h.host.startTurn({ threadId: h.runtime.id, input: [{ type: "text", text }] });
	const deadline = Date.now() + 3000;
	while (!h.sent.some(message => message.method === "turn/completed" && message.params.turn.id === result.turn.id)) {
		if (Date.now() > deadline) throw new Error("Desktop turn did not complete");
		await new Promise(resolve => setTimeout(resolve, 5));
	}
	await h.runtime.session.waitForIdle();
	return result.turn;
}

test("Desktop sidebar leaves loading after a completed answer", async t => {
	const h = await harness(t);
	h.faux.setResponses([h.fauxAssistantMessage("done")]);
	// Pinned Desktop sets threadRuntimeStatus=active optimistically on send.
	let status = { type: "active", activeFlags: [] };
	await runTurn(h);
	for (const message of h.sent) {
		if (message.method === "thread/status/changed") status = message.params.status;
	}
	assert.equal(h.sent.find(m => m.method === "turn/completed").params.turn.status, "completed");
	assert.equal(status.type, "idle", "turn/completed alone does not clear Desktop's runtime spinner");
});

test("Desktop side-chat fork accepts its boundary without starting a model or changing its parent", async t => {
	const h = await harness(t, { persistent: true });
	h.faux.setResponses([h.fauxAssistantMessage("parent answer"), h.fauxAssistantMessage("side answer")]);
	await runTurn(h);
	const parent = h.runtime.session.sessionFile;
	await h.host.disposeThread(h.runtime.id);
	const before = await fs.readFile(parent, "utf8");
	const fork = await h.host.dispatch("thread/fork", { threadId: h.runtime.id, path: parent, ephemeral: true, excludeTurns: true });
	const boundary = "Inherited history is reference only. Only new messages are active instructions.";
	await h.host.dispatch("thread/inject_items", { threadId: fork.thread.id,
		items: [{ type: "message", role: "user", content: [{ type: "input_text", text: boundary }] }] });
	assert.equal(h.faux.state.callCount, 1, "injection must not run a prompt");
	assert.equal(fork.thread.ephemeral, true);
	assert.equal(fork.thread.path, null);
	await h.host.startTurn({ threadId: fork.thread.id, input: [{ type: "text", text: "side question" }] });
	const side = h.host.threads.get(fork.thread.id);
	await waitForTurn(h.host, side.id);
	assert.ok(side.session.messages.some(m => typeof m.content === "string" ? m.content === boundary : m.content?.some(b => b.text === boundary)));
	assert.equal(await fs.readFile(parent, "utf8"), before);
	assert.equal((await h.host.sdk.SessionManager.listAll()).length, 1, "ephemeral fork must not leak a persistent copy");
});

test("Desktop fork lastTurnId excludes later turns and can resume using its returned cwd", async t => {
	const h = await harness(t, { persistent: true });
	h.faux.setResponses([h.fauxAssistantMessage("first answer"), h.fauxAssistantMessage("later answer")]);
	const first = await runTurn(h, "first question");
	await runTurn(h, "later question");
	const file = h.runtime.session.sessionFile;
	await h.host.disposeThread(h.runtime.id);
	const before = await fs.readFile(file, "utf8");
	const fork = await h.host.dispatch("thread/fork", { threadId: h.runtime.id, path: file,
		cwd: h.directory, lastTurnId: first.id, excludeTurns: true });
	const resumed = await h.host.dispatch("thread/resume", { threadId: fork.thread.id, path: fork.thread.path, cwd: fork.cwd });
	assert.deepEqual(resumed.thread.turns.map(t => t.id), [first.id]);
	assert.equal(await fs.readFile(file, "utf8"), before);
	const files = await fs.readdir(path.dirname(file));
	await assert.rejects(h.host.forkThread({ threadId: h.runtime.id, lastTurnId: "missing-turn" }), /Turn not found/);
	assert.deepEqual(await fs.readdir(path.dirname(file)), files, "bad boundary must not publish a fork");
});

test("injection rejects unsupported batches before writing and updates an idle loaded runtime", async t => {
	const h = await harness(t, { persistent: true });
	h.faux.setResponses([h.fauxAssistantMessage("answer")]);
	await runTurn(h);
	const file = h.runtime.session.sessionFile;
	const before = await fs.readFile(file, "utf8");
	const item = { type: "message", role: "user", content: [{ type: "input_text", text: "context" }] };
	await assert.rejects(h.host.dispatch("thread/inject_items", { threadId: h.runtime.id,
		items: [item, { ...item, role: "system" }] }), /only user text/);
	assert.equal(await fs.readFile(file, "utf8"), before);
	await h.host.dispatch("thread/inject_items", { threadId: h.runtime.id, items: [item] });
	assert.equal(h.faux.state.callCount, 1);
	assert.equal(h.runtime.session.messages.at(-1).content[0].text, "context");
	assert.equal(h.runtime.session.sessionManager.getLeafEntry().type, "custom_message");
	const injected = await fs.readFile(file, "utf8");
	h.runtime.activeTurnId = "active-fixture";
	try {
		await assert.rejects(h.host.dispatch("thread/inject_items", { threadId: h.runtime.id, items: [item] }), /active/);
	} finally { h.runtime.activeTurnId = null; }
	assert.equal(await fs.readFile(file, "utf8"), injected);
});

test("Desktop fork and resume cwd hints cannot move a native Pi session", async t => {
	const h = await harness(t, { persistent: true });
	h.faux.setResponses([h.fauxAssistantMessage("source"), h.fauxAssistantMessage("fork reply")]);
	await runTurn(h);
	const file = h.runtime.session.sessionFile;
	const manager = h.runtime.session.sessionManager;
	const leaf = manager.getLeafId();
	manager.appendMessage({ role: "user", content: "discarded branch", timestamp: Date.now() });
	manager.branch(leaf);
	manager.appendCustomEntry("codex-app-pi.branch-selection", {});
	await h.host.disposeThread(h.runtime.id);
	const desktopCwd = path.join(h.directory, "unrelated-host-cwd");
	await fs.mkdir(desktopCwd);
	const fork = await h.host.forkThread({ threadId: h.runtime.id, path: file, cwd: desktopCwd, excludeTurns: true });
	assert.equal(fork.cwd, h.directory);
	const resumed = await h.host.resumeThread({ threadId: fork.thread.id, path: fork.thread.path, cwd: desktopCwd });
	assert.equal(resumed.thread.cwd, h.directory);
	assert.ok(!(await fs.readFile(fork.thread.path, "utf8")).includes("discarded branch"), "copy only the selected native branch");
	assert.ok((await fs.readFile(file, "utf8")).includes("discarded branch"), "retain the source's complete tree");
	await h.host.startTurn({ threadId: fork.thread.id, cwd: desktopCwd, input: [{ type: "text", text: "continue fork" }] });
	await waitForTurn(h.host, fork.thread.id);
	assert.equal(h.host.threads.get(fork.thread.id).cwd, h.directory);
});

test("settled persistent turns release ownership only after extension shutdown completes", async t => {
	const shutdownStarted = Promise.withResolvers();
	const allowShutdown = Promise.withResolvers();
	const h = await harness(t, { persistent: true, lazy: true, extensionFactories: [pi => {
		pi.on("session_shutdown", async () => { shutdownStarted.resolve(); await allowShutdown.promise; });
	}] });
	h.faux.setResponses([h.fauxAssistantMessage("settled")]);
	let runtime;
	try {
		await h.host.startTurn({ threadId: h.thread.id, input: [{ type: "text", text: "release after completion" }] });
		runtime = h.host.threads.get(h.thread.id);
		await waitForTurn(h.host, h.thread.id);
		await Promise.race([
			shutdownStarted.promise,
			new Promise((_, reject) => setTimeout(() => reject(new Error("automatic shutdown did not start")), 1000)),
		]);
		assert.equal(fsSync.existsSync(`${runtime.session.sessionFile}.desktop-lock`), true,
			"ownership must remain while session_shutdown is running");
	} finally {
		allowShutdown.resolve();
	}
	const deadline = Date.now() + 1000;
	while (h.host.threads.has(h.thread.id)) {
		if (Date.now() > deadline) throw new Error("automatic shutdown did not finish");
		await new Promise(resolve => setTimeout(resolve, 5));
	}
	assert.equal(fsSync.existsSync(`${runtime.session.sessionFile}.desktop-lock`), false);
});

test("session liveness keeps a settled runtime until detached work finishes", async t => {
	let active = true;
	const h = await harness(t, { persistent: true, lazy: true, extensionFactories: [pi => {
		let release = () => {};
		pi.on("session_start", (_event, ctx) => {
			release = globalThis[Symbol.for("@agegr/pi-web/session-liveness/v1")].register({
				name: "fixture", sessionId: ctx.sessionManager.getSessionId(),
				sessionFile: ctx.sessionManager.getSessionFile(), isActive: () => active,
			});
		});
		pi.on("session_shutdown", () => release());
	}] });
	h.faux.setResponses([h.fauxAssistantMessage("background started")]);
	await h.host.startTurn({ threadId: h.thread.id, input: [{ type: "text", text: "start background work" }] });
	const runtime = h.host.threads.get(h.thread.id);
	await waitForTurn(h.host, h.thread.id);
	await new Promise(resolve => setTimeout(resolve, 200));
	assert.equal(h.host.threads.get(h.thread.id), runtime);
	assert.equal(fsSync.existsSync(`${runtime.session.sessionFile}.desktop-lock`), true);
	active = false;
	const deadline = Date.now() + 2500;
	while (h.host.threads.has(h.thread.id)) {
		if (Date.now() > deadline) throw new Error("runtime remained after detached work finished");
		await new Promise(resolve => setTimeout(resolve, 5));
	}
	assert.equal(fsSync.existsSync(`${runtime.session.sessionFile}.desktop-lock`), false);
});

test("a failing session liveness provider preserves ownership", async t => {
	const h = await harness(t, { persistent: true, lazy: true, extensionFactories: [pi => {
		let release = () => {};
		pi.on("session_start", (_event, ctx) => {
			release = globalThis[Symbol.for("@agegr/pi-web/session-liveness/v1")].register({
				name: "broken-fixture", sessionId: ctx.sessionManager.getSessionId(),
				isActive: () => { throw new Error("fixture liveness failure"); },
			});
		});
		pi.on("session_shutdown", () => release());
	}] });
	h.faux.setResponses([h.fauxAssistantMessage("settled")]);
	await h.host.startTurn({ threadId: h.thread.id, input: [{ type: "text", text: "do not release" }] });
	const runtime = h.host.threads.get(h.thread.id);
	await waitForTurn(h.host, h.thread.id);
	await new Promise(resolve => setTimeout(resolve, 200));
	assert.equal(h.host.threads.get(h.thread.id), runtime);
	assert.equal(fsSync.existsSync(`${runtime.session.sessionFile}.desktop-lock`), true);
});

test("a new send waits for automatic shutdown and reopens the session", async t => {
	const shutdownStarted = Promise.withResolvers();
	const allowShutdown = Promise.withResolvers();
	let shutdowns = 0;
	const h = await harness(t, { persistent: true, lazy: true, extensionFactories: [pi => {
		pi.on("session_shutdown", async () => {
			shutdowns += 1;
			if (shutdowns === 1) { shutdownStarted.resolve(); await allowShutdown.promise; }
		});
	}] });
	h.faux.setResponses([h.fauxAssistantMessage("first"), h.fauxAssistantMessage("second")]);
	await h.host.startTurn({ threadId: h.thread.id, input: [{ type: "text", text: "first" }] });
	await waitForTurn(h.host, h.thread.id);
	await shutdownStarted.promise;
	const second = h.host.startTurn({ threadId: h.thread.id, input: [{ type: "text", text: "second" }] });
	allowShutdown.resolve();
	await second;
	await waitForTurn(h.host, h.thread.id);
	assert.equal(h.faux.state.callCount, 2);
	assert.equal(h.sent.filter(message => message.method === "turn/completed").length, 2);
});

test("opening new and existing sessions is passive; first send acquires ownership and reloads history", async t => {
	const h = await harness(t, { persistent: true, lazy: true });
	assert.equal(h.host.threads.size, 0, "creating a UI thread must not create a writable runtime");
	assert.equal(fsSync.existsSync(`${h.thread.path}.desktop-lock`), false);
	h.faux.setResponses([h.fauxAssistantMessage("initial reply"), h.fauxAssistantMessage("continued reply")]);
	await h.host.startTurn({ threadId: h.thread.id, input: [{ type: "text", text: "initial question" }] });
	const first = h.host.threads.get(h.thread.id);
	await waitForTurn(h.host, h.thread.id);
	const file = first.session.sessionFile;
	await h.host.disposeThread(h.thread.id);
	assert.equal(fsSync.existsSync(`${file}.desktop-lock`), false);
	const bytes = await fs.readFile(file, "utf8");
	const reader = new PiHost({ sdk: h.host.sdk, agentDir: h.directory, codexHome: h.directory, send() {} });
	t.after(() => reader.shutdown());
	reader.createServices = () => assert.fail("viewing must not initialize extensions");
	const resumed = await reader.resumeThread({ threadId: h.thread.id });
	assert.equal(resumed.thread.turns.at(-1).items.at(-1).text, "initial reply");
	assert.equal(reader.threads.size, 0);
	assert.equal(fsSync.existsSync(`${file}.desktop-lock`), false);
	assert.equal(await fs.readFile(file, "utf8"), bytes);

	// Another native client writes while this view is idle. Sending must load it.
	const other = h.sdk.SessionManager.open(file);
	other.appendMessage({ role: "user", content: "external update", timestamp: Date.now() });
	reader.createServices = h.host.createServices;
	await reader.startTurn({ threadId: h.thread.id, input: [{ type: "text", text: "continue latest" }] });
	const current = reader.threads.get(h.thread.id);
	await waitForTurn(reader, h.thread.id);
	assert.ok(current.session.messages.some(m => m.role === "user" && m.content === "external update"));
	const releaseDeadline = Date.now() + 1000;
	while (reader.threads.has(h.thread.id)) {
		if (Date.now() > releaseDeadline) throw new Error("settled runtime did not auto-release");
		await new Promise(resolve => setTimeout(resolve, 5));
	}
	assert.equal(fsSync.existsSync(`${file}.desktop-lock`), false);
});

test("view settings and native rename do not open a runtime; forks remain passive", async t => {
	const h = await harness(t, { persistent: true, lazy: true });
	await h.host.updateThreadSettings({ threadId: h.thread.id, model: "desktop-test/faux", effort: "off" });
	assert.equal(h.host.threads.size, 0);
	await h.host.setThreadName({ threadId: h.thread.id, name: "passive draft" });
	assert.equal(h.host.threads.size, 0);
	h.faux.setResponses([h.fauxAssistantMessage("saved")]);
	await h.host.startTurn({ threadId: h.thread.id, input: [{ type: "text", text: "save" }] });
	const runtime = h.host.threads.get(h.thread.id);
	await waitForTurn(h.host, h.thread.id);
	await h.host.disposeThread(h.thread.id);
	const services = h.host.createServices;
	h.host.createServices = () => assert.fail("rename/fork must not load extensions");
	await h.host.resumeThread({ threadId: h.thread.id });
	await h.host.setThreadName({ threadId: h.thread.id, name: "passive saved" });
	const fork = await h.host.forkThread({ threadId: h.thread.id, name: "passive fork" });
	assert.equal(fork.thread.name, "passive fork");
	assert.equal(h.host.threads.size, 0);
	assert.equal(fsSync.existsSync(`${fork.thread.path}.desktop-lock`), false);
	assert.equal(fsSync.existsSync(`${runtime.session.sessionFile}.desktop-lock`), false);
	h.host.createServices = services;
});

test("pending first send publishes a cancellable turn before runtime creation, and settles after cleanup", async t => {
	const h = await harness(t, { persistent: true, lazy: true });
	const create = h.host.createServices;
	const entered = Promise.withResolvers();
	const gate = Promise.withResolvers();
	h.host.createServices = async cwd => { entered.resolve(); await gate.promise; return create(cwd); };
	h.sent.length = 0;
	const request = h.host.handle({ id: "prepare", method: "turn/start", params: {
		threadId: h.thread.id, input: [{ type: "text", text: "never execute" }],
	} });
	try {
		await entered.promise;
		const started = h.sent.find(m => m.method === "turn/started");
		assert.ok(started?.params.turn.id, "GUI needs a turn ID while initialization is blocked");
		assert.ok(!h.sent.some(m => m.id === "prepare"), "start request must still be pending");
		await h.host.handle({ id: "stale", method: "turn/interrupt", params: { threadId: h.thread.id, turnId: "old-turn" } });
		assert.match(h.sent.find(m => m.id === "stale").error.message, /match/);
		await h.host.handle({ id: "stop", method: "turn/interrupt", params: { threadId: h.thread.id, turnId: started.params.turn.id } });
		assert.ok(h.sent.find(m => m.id === "stop").result);
		assert.ok(fsSync.existsSync(`${h.thread.path}.desktop-lock`), "Stop must not release a still-initializing runtime");
		assert.ok(!h.sent.some(m => m.method === "turn/completed"), "cleanup has not completed");
	} finally { gate.resolve(); await request; }
	assert.equal(h.faux.state.callCount, 0);
	assert.match(h.sent.find(m => m.id === "prepare").error.message, /interrupted/);
	const ended = h.sent.filter(m => m.method === "turn/completed");
	assert.equal(ended.length, 1);
	assert.equal(ended[0].params.turn.status, "interrupted");
	assert.equal(ended[0].params.turn.id, h.sent.find(m => m.method === "turn/started").params.turn.id);
	assert.equal(h.sent.findLast(m => m.method === "thread/status/changed").params.status.type, "idle");
	assert.equal(fsSync.existsSync(`${h.thread.path}.desktop-lock`), false);
});

test("preparation identity survives history reads and startup failure settles it exactly once", async t => {
	const h = await harness(t, { persistent: true, lazy: true });
	const create = h.host.createServices;
	const entered = Promise.withResolvers();
	const gate = Promise.withResolvers();
	h.host.createServices = async cwd => { entered.resolve(); await gate.promise; throw Error("fixture prepare failed"); };
	h.sent.length = 0;
	const request = h.host.handle({ id: "prepare", method: "turn/start", params: {
		threadId: h.thread.id, input: [{ type: "text", text: "do not persist" }],
	} });
	try {
		await entered.promise;
		const turn = h.sent.find(m => m.method === "turn/started").params.turn;
		const { thread } = await h.host.readThread({ threadId: h.thread.id, includeTurns: true });
		assert.equal(thread.status.type, "active");
		assert.equal(thread.turns.at(-1).id, turn.id);
		assert.equal((await h.host.listTurns({ threadId: h.thread.id })).data.at(-1).id, turn.id);
	} finally { gate.resolve(); await request; }
	const failed = h.sent.filter(m => m.method === "turn/completed");
	assert.equal(failed.length, 1);
	assert.equal(failed[0].params.turn.status, "failed");
	assert.equal(h.faux.state.callCount, 0);
	assert.ok(!fsSync.existsSync(h.thread.path));
	h.host.createServices = create;
	h.faux.setResponses([h.fauxAssistantMessage("retry succeeded")]);
	h.sent.length = 0;
	const { turn } = await h.host.startTurn({ threadId: h.thread.id, input: [{ type: "text", text: "retry" }] });
	await waitForTurn(h.host, h.thread.id);
	for (const method of ["turn/started", "turn/completed"]) {
		const events = h.sent.filter(m => m.method === method);
		assert.equal(events.length, 1);
		assert.equal(events[0].params.turn.id, turn.id);
	}
	assert.equal((await h.host.listTurns({ threadId: h.thread.id })).data.at(-1).id, turn.id);
});

test("Stop during real extension binding retains ownership through shutdown hooks and can retry", async t => {
	const entered = Promise.withResolvers();
	const binding = Promise.withResolvers();
	const closing = Promise.withResolvers();
	const cleanup = Promise.withResolvers();
	const h = await harness(t, { persistent: true, lazy: true, extensionFactories: [pi => {
		pi.on("session_start", async () => { entered.resolve(); await binding.promise; });
		pi.on("session_shutdown", async () => { closing.resolve(); await cleanup.promise; });
	}] });
	h.sent.length = 0;
	const request = h.host.handle({ id: "prepare", method: "turn/start", params: {
		threadId: h.thread.id, input: [{ type: "text", text: "cancel binding" }],
	} });
	try {
		await entered.promise;
		const turn = h.sent.find(m => m.method === "turn/started").params.turn;
		await assert.rejects(h.host.interruptTurn({ threadId: h.thread.id, turnId: "stale-binding-turn" }), /match/);
		for (let i = 0; i < 2; i++) await h.host.interruptTurn({ threadId: h.thread.id, turnId: turn.id });
		assert.ok(fsSync.existsSync(`${h.thread.path}.desktop-lock`));
		assert.equal((await h.host.readThread({ threadId: h.thread.id, includeTurns: true })).thread.turns.at(-1).id, turn.id);
		binding.resolve();
		await closing.promise;
		assert.ok(fsSync.existsSync(`${h.thread.path}.desktop-lock`));
		assert.ok(!h.sent.some(m => m.method === "turn/completed"));
	} finally { binding.resolve(); cleanup.resolve(); await request; }
	assert.equal(h.faux.state.callCount, 0);
	assert.equal(h.sent.filter(m => m.method === "turn/started").length, 1);
	assert.equal(h.sent.filter(m => m.method === "turn/completed").length, 1);
	assert.ok(!fsSync.existsSync(`${h.thread.path}.desktop-lock`));
	h.sent.length = 0;
	h.faux.setResponses([h.fauxAssistantMessage("after cancelled binding")]);
	await h.host.startTurn({ threadId: h.thread.id, input: [{ type: "text", text: "retry binding" }] });
	await waitForTurn(h.host, h.thread.id);
	assert.equal(h.faux.state.callCount, 1);
	assert.equal(h.sent.filter(m => m.method === "turn/started").length, 1);
	assert.equal(h.sent.filter(m => m.method === "turn/completed").length, 1);
});

test("unreadable prompt attachments fail before publishing a preparation turn or acquiring ownership", async t => {
	const h = await harness(t, { persistent: true, lazy: true });
	h.sent.length = 0;
	await h.host.handle({ id: "bad-input", method: "turn/start", params: {
		threadId: h.thread.id, input: [{ type: "localImage", path: path.join(h.directory, "missing.png") }],
	} });
	assert.ok(h.sent.find(m => m.id === "bad-input").error);
	assert.ok(!h.sent.some(m => m.method === "turn/started"));
	assert.equal(h.faux.state.callCount, 0);
	assert.ok(!fsSync.existsSync(`${h.thread.path}.desktop-lock`));
});

test("concurrent first sends admit one writer and Stop during opening starts no model", async t => {
	const h = await harness(t, { persistent: true, lazy: true });
	const create = h.host.createServices;
	let release;
	const gate = new Promise(resolve => { release = resolve; });
	let entered;
	const creating = new Promise(resolve => { entered = resolve; });
	h.host.createServices = async cwd => { entered(); await gate; return create(cwd); };
	const request = { threadId: h.thread.id, input: [{ type: "text", text: "cancel before starting" }] };
	const first = h.host.startTurn(request);
	// Observe rejection immediately; Stop invalidates this pending admission.
	const failed = assert.rejects(first, /interrupted/);
	await creating;
	try {
		await assert.rejects(h.host.startTurn(request), /opening|preparing|active turn/);
		await h.host.interruptTurn({ threadId: h.thread.id });
	} finally { release(); }
	await failed;
	assert.equal(h.faux.state.callCount, 0);
	assert.equal(h.host.threads.size, 0);
	assert.equal(fsSync.existsSync(`${h.thread.path}.desktop-lock`), false);
	h.host.createServices = create;
	h.faux.setResponses([h.fauxAssistantMessage("retry after cancelled preparation")]);
	await h.host.startTurn({ ...request, input: [{ type: "text", text: "retry" }] });
	await waitForTurn(h.host, h.thread.id);
	assert.equal(h.faux.state.callCount, 1);
});

test("two idle Desktop views race at first send; only one starts a model", async t => {
	const h = await harness(t, { persistent: true });
	h.faux.setResponses([h.fauxAssistantMessage("seed")]);
	await runTurn(h);
	const id = h.runtime.id;
	await h.host.disposeThread(id);
	const otherSent = [];
	const other = new PiHost({ sdk: h.host.sdk, agentDir: h.directory, codexHome: h.directory, send: m => otherSent.push(m) });
	other.createServices = h.host.createServices;
	t.after(() => other.shutdown());
	await Promise.all([h.host.resumeThread({ threadId: id }), other.resumeThread({ threadId: id })]);
	assert.equal(h.host.threads.size + other.threads.size, 0);
	h.host.send = message => h.sent.push(message); // Hold the harmless Desktop callback.
	h.faux.setResponses([h.fauxAssistantMessage([h.fauxToolCall("desktop_echo", {}, { id: "race-tool" })], { stopReason: "toolUse" }), h.fauxAssistantMessage("done")]);
	const before = h.faux.state.callCount;
	const results = await Promise.allSettled([h.host, other].map(host => host.startTurn({ threadId: id, input: [{ type: "text", text: "race" }] })));
	assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
	assert.match(results.find(r => r.status === "rejected").reason.message, /active writer/);
	const winner = results[0].status === "fulfilled" ? h.host : other;
	const loser = winner === h.host ? other : h.host;
	const loserSent = loser === other ? otherSent : h.sent;
	const failed = loserSent.findLast(m => m.method === "turn/completed").params.turn;
	assert.equal(failed.status, "failed");
	assert.equal(failed.id, loserSent.findLast(m => m.method === "turn/started").params.turn.id);
	const deadline = Date.now() + 3000;
	while (!winner.dynamicCalls.size) {
		if (Date.now() > deadline) throw new Error("fixture tool did not start");
		await new Promise(resolve => setTimeout(resolve, 5));
	}
	assert.equal(h.faux.state.callCount, before + 1);
	await assert.rejects(loser.startTurn({ threadId: id, input: [{ type: "text", text: "still busy" }] }), /active writer/);
	const requestId = [...winner.dynamicCalls.keys()][0];
	await winner.handle({ id: requestId, result: { success: true, contentItems: [] } });
	await winner.threads.get(id).session.waitForIdle();
	await winner.disposeThread(id);
	assert.equal((await loser.resumeThread({ threadId: id })).thread.turns.at(-1).items.at(-1).text, "done");
});

test("unsent drafts keep project metadata and can be archived or deleted without a runtime", async t => {
	const h = await harness(t, { persistent: true, lazy: true });
	const ephemeral = await h.host.startThread({ cwd: h.directory, ephemeral: true });
	const { project } = await h.host.createProject({ name: "draft project", idempotencyKey: "draft-project", roots: [{ path: h.directory }] }, false);
	await h.host.updateThreadMetadata({ threadId: ephemeral.thread.id, projectId: project.id });
	assert.equal((await h.host.resumeThread({ threadId: ephemeral.thread.id })).thread.projectId, project.id);
	await h.host.archiveThread({ threadId: h.thread.id }, true);
	await h.host.deleteThread({ threadId: ephemeral.thread.id });
	assert.equal(h.host.threads.size, 0);
	assert.equal((await h.host.listLoadedThreads()).data.length, 0);
});

test("disposal keeps the lease until async cleanup completes, then another viewer can send", async t => {
	const h = await harness(t, { persistent: true });
	h.faux.setResponses([h.fauxAssistantMessage("before disposal"), h.fauxAssistantMessage("after disposal")]);
	await runTurn(h);
	const id = h.runtime.id;
	let release;
	const gate = new Promise(resolve => { release = resolve; });
	const original = h.runtime.lifecycle.dispose.bind(h.runtime.lifecycle);
	h.runtime.lifecycle.dispose = async () => { await gate; await original(); };
	const disposal = h.host.disposeThread(id);
	const other = new PiHost({ sdk: h.host.sdk, agentDir: h.directory, codexHome: h.directory, send() {} });
	other.createServices = h.host.createServices;
	t.after(() => other.shutdown());
	try {
		await assert.rejects(other.startTurn({ threadId: id, input: [{ type: "text", text: "too early" }] }), /active writer/);
		assert.equal(h.faux.state.callCount, 1);
	} finally { release(); }
	await disposal;
	await other.startTurn({ threadId: id, input: [{ type: "text", text: "now continue" }] });
	await waitForTurn(other, id);
	assert.equal(h.faux.state.callCount, 2);
	await other.shutdown();
});

test("failed first-send initialization releases ownership and the same draft can retry", async t => {
	const h = await harness(t, { persistent: true, lazy: true });
	const create = h.host.createServices;
	h.host.createServices = async () => { throw new Error("fixture startup failed"); };
	await assert.rejects(h.host.startTurn({ threadId: h.thread.id, input: [{ type: "text", text: "fails" }] }), /fixture startup failed/);
	assert.equal(fsSync.existsSync(`${h.thread.path}.desktop-lock`), false);
	assert.equal(h.host.threads.size, 0);
	h.host.createServices = create;
	h.faux.setResponses([h.fauxAssistantMessage("startup recovered")]);
	await h.host.startTurn({ threadId: h.thread.id, input: [{ type: "text", text: "retry" }] });
	await waitForTurn(h.host, h.thread.id);
	assert.equal(h.faux.state.callCount, 1);
});

test("resume treats Desktop cwd as a hint without rewriting the native cwd", async t => {
	const h = await harness(t, { persistent: true });
	h.faux.setResponses([h.fauxAssistantMessage("history")]);
	await runTurn(h);
	const id = h.runtime.id;
	const file = h.runtime.session.sessionFile;
	const other = path.join(h.directory, "other-cwd");
	await fs.mkdir(other);
	const original = await fs.readFile(file, "utf8");
	assert.equal((await h.host.resumeThread({ threadId: id, cwd: other })).cwd, h.directory);
	await h.host.disposeThread(id);
	for (const explicitPath of [undefined, file]) {
		const result = await h.host.resumeThread({ threadId: id, path: explicitPath, cwd: other });
		assert.equal(result.cwd, h.directory);
		assert.equal(h.host.threads.size, 0);
	}
	assert.equal(await fs.readFile(file, "utf8"), original);
});

test("persistent native session supports project, rename, fork, archive, and unarchive", async t => {
	const h = await harness(t, { persistent: true });
	h.faux.setResponses([h.fauxAssistantMessage("persistent reply")]);
	await runTurn(h);
	const { project } = await h.host.createProject({ name: "acceptance", idempotencyKey: "acceptance", roots: [{ path: h.directory }] }, false);
	await h.host.updateProject({ projectId: project.id, name: "renamed project" });
	await h.host.setThreadName({ threadId: h.runtime.id, name: "renamed session" });
	assert.equal((await h.host.listThreads({ projectId: project.id })).data[0].name, "renamed session");
	const original = await fs.readFile(h.runtime.session.sessionFile, "utf8");
	const fork = await h.host.forkThread({ threadId: h.runtime.id, name: "forked session" });
	assert.notEqual(fork.thread.id, h.runtime.id);
	assert.equal(await fs.readFile(h.runtime.session.sessionFile, "utf8"), original);
	await h.host.archiveThread({ threadId: fork.thread.id }, true);
	assert.deepEqual((await h.host.listThreads({ archived: true })).data.map(t => t.id), [fork.thread.id]);
	await h.host.archiveThread({ threadId: fork.thread.id }, false);
	assert.equal((await h.host.listThreads({})).data.length, 2);
	await h.host.deleteProject({ projectId: project.id });
	assert.equal((await h.host.listProjects({})).data.length, 0);
	assert.equal((await h.host.listThreads({})).data.length, 2, "removing project metadata preserves native sessions");
});

test("existing Codex writer-conflict path can read paginated history without acquiring a writer", async t => {
	const h = await harness(t, { persistent: true });
	h.faux.setResponses([h.fauxAssistantMessage("first reply"), h.fauxAssistantMessage("second reply")]);
	await runTurn(h, "first question");
	await runTurn(h, "second question");
	const readerSent = [];
	const reader = new PiHost({ sdk: h.host.sdk, agentDir: h.directory, codexHome: h.directory, send: m => readerSent.push(m) });
	t.after(() => reader.shutdown());
	reader.createServices = () => assert.fail("read-only history must not load tools/extensions");
	const file = h.runtime.session.sessionFile;
	const original = await fs.readFile(file, "utf8");
	await reader.handle({ id: "resume", method: "thread/resume", params: { threadId: h.runtime.id } });
	const conflict = readerSent.find(m => m.id === "resume").error;
	// Pinned UI's actual classifier. An ordinary busy/IO error must not be mislabeled.
	assert.match(conflict.message, /already has an active writer|already has a live local writer/);
	const { thread } = await reader.readThread({ threadId: h.runtime.id });
	assert.equal(thread.historyMode, "paginated");
	const newest = await reader.listTurns({ threadId: thread.id, sortDirection: "desc", limit: 1, itemsView: "notLoaded" });
	assert.equal(newest.data.length, 1);
	assert.deepEqual(newest.data[0].items, []);
	const older = await reader.listTurns({ threadId: thread.id, sortDirection: "desc", limit: 1, cursor: newest.nextCursor });
	assert.notEqual(newest.data[0].id, older.data[0].id);
	assert.equal(older.nextCursor, null);
	const items = await reader.listItems({ threadId: thread.id, turnId: newest.data[0].id, sortDirection: "desc", limit: 1 });
	assert.equal(items.data[0].turnId, newest.data[0].id);
	assert.equal(items.data[0].item.text, "second reply");
	assert.ok(items.nextCursor);
	const opening = await reader.listItems({ threadId: thread.id, turnId: newest.data[0].id, sortDirection: "desc", limit: 1, cursor: items.nextCursor });
	assert.equal(opening.data[0].item.type, "userMessage");
	assert.equal(opening.nextCursor, null);
	await assert.rejects(reader.listTurns({ threadId: thread.id, cursor: "invalid" }), /cursor/);
	await assert.rejects(reader.listItems({ threadId: thread.id, limit: 0 }), /limit/);
	assert.equal(reader.threads.size, 0);
	for (const method of ["turn/start", "thread/name/set", "thread/delete"]) {
		await assert.rejects(reader.dispatch(method, { threadId: thread.id, name: "forbidden", input: [{ type: "text", text: "forbidden" }] }), /active writer/);
	}
	assert.equal(await fs.readFile(file, "utf8"), original);
	// Release is real: after the original runtime closes, a new writer can resume.
	await h.host.disposeThread(thread.id);
	reader.createServices = h.host.createServices;
	const resumed = await reader.resumeThread({ threadId: thread.id });
	assert.equal(resumed.thread.id, thread.id);
	assert.equal(resumed.itemsBackwardsCursor, null);
	assert.equal(resumed.turnsBackwardsCursor, "0");
	assert.equal(resumed.thread.historyMode, "paginated");
	await reader.shutdown();
});

test("Pi Web occupancy labels history, gates all shared-file mutations, and clears after settlement", async t => {
	const h = await harness(t, { persistent: true });
	h.faux.setResponses([h.fauxAssistantMessage("initial history"), h.fauxAssistantMessage("continued")]);
	await runTurn(h);
	const id = h.runtime.id;
	const file = h.runtime.session.sessionFile;
	await h.host.disposeThread(id);
	let running = false, broken = false, requests = 0;
	const server = http.createServer((req, res) => {
		requests++;
		assert.equal(req.method, "GET");
		assert.equal(req.url, "/api/sessions");
		res.writeHead(broken ? 503 : 200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ sessions: [{ id, path: file }], runningSessionIds: running ? [id] : [] }));
	});
	await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
	const web = new PiWebStatus({ url: `http://127.0.0.1:${server.address().port}`, cacheMs: 0 });
	const sent = [];
	const reader = new PiHost({ sdk: h.host.sdk, agentDir: h.directory, codexHome: h.directory, piWebStatus: web, send: m => sent.push(m) });
	t.after(async () => { await reader.shutdown(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
	reader.createServices = () => assert.fail("viewing/gated writes must not load extensions");
	// An idle Web runtime is not an active writer. A previously opened view
	// must still be rechecked when Web starts running later.
	await reader.resumeThread({ threadId: id });
	running = true;
	const bytes = await fs.readFile(file, "utf8");
	const listed = (await reader.listThreads({})).data[0];
	assert.match(listed.name, /Pi Web 运行中/);
	assert.equal(listed.status.type, "active");
	assert.equal((await reader.readThread({ threadId: id, includeTurns: true })).thread.turns.at(-1).items.at(-1).text, "initial history");
	const inputs = { threadId: id, name: "forbidden", input: [{ type: "text", text: "forbidden" }],
		items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "forbidden" }] }] };
	for (const method of ["thread/resume", "turn/start", "thread/name/set", "thread/delete", "thread/fork",
		"thread/inject_items", "thread/compact/start", "thread/revert", "thread/rollback"]) {
		await assert.rejects(reader.dispatch(method, inputs), /already has an active writer.*Pi Web/, method);
	}
	assert.equal(reader.threads.size, 0);
	assert.equal(fsSync.existsSync(`${file}.desktop-lock`), false);
	assert.equal(await fs.readFile(file, "utf8"), bytes);
	assert.equal(sent.findLast(m => m.method === "thread/status/changed").params.status.type, "active", "a rejected local turn must not clear Web's running status");
	const turns = (await reader.listTurns({ threadId: id })).data;
	assert.equal(turns.length, 1);
	assert.equal((await reader.listItems({ threadId: id, turnId: turns[0].id })).data.at(-1).item.text, "initial history");
	broken = true;
	await reader.pollWebStatus();
	assert.doesNotMatch(sent.findLast(m => m.method === "thread/name/updated").params.threadName, /Pi Web/);
	assert.equal(sent.findLast(m => m.method === "thread/status/changed").params.status.type, "idle");
	await reader.resumeThread({ threadId: id });
	await reader.checkWebSession(id, file); // Unknown means no detected Pi Web occupancy.
	assert.equal(await fs.readFile(file, "utf8"), bytes);
	broken = false;
	running = false;
	await reader.pollWebStatus();
	assert.doesNotMatch(sent.findLast(m => m.method === "thread/name/updated").params.threadName, /Pi Web/);
	assert.equal(sent.findLast(m => m.method === "thread/status/changed").params.status.type, "idle");
	// Simulate a Web append before release. The next Desktop send must reopen
	// the file, not use the passive view's old context.
	const external = h.sdk.SessionManager.open(file);
	external.appendMessage({ role: "user", content: "new Web context", timestamp: Date.now() });
	reader.createServices = h.host.createServices;
	await reader.resumeThread({ threadId: id });
	await reader.startTurn({ threadId: id, input: [{ type: "text", text: "continue" }] });
	const owned = reader.threads.get(id);
	const release = reader.sessionLiveness.register({ name: "owned-background", sessionId: id, isActive: () => true });
	t.after(release);
	assert.ok(owned.session.messages.some(m => m.role === "user" && m.content === "new Web context"));
	await waitForTurn(reader, id);
	assert.equal(h.faux.state.callCount, 2);
	// Retained pi-codex work belongs to this host, not an external Web writer.
	running = true;
	const beforeResume = requests;
	assert.equal((await reader.resumeThread({ threadId: id })).thread.id, id);
	assert.equal(reader.threads.get(id), owned);
	assert.equal(requests, beforeResume);
	await reader.shutdown();
	assert.equal(web.closed, true);
});

test("native history read never rewrites legacy JSONL", async t => {
	const h = await harness(t);
	const file = path.join(h.directory, "legacy.jsonl");
	const bytes = JSON.stringify({ type: "session", version: 1, id: "12345678-1234-1234-1234-123456789abc", cwd: h.directory, timestamp: new Date().toISOString() }) + "\n";
	await fs.writeFile(file, bytes);
	h.host.findSession = async () => ({ path: file, id: "12345678-1234-1234-1234-123456789abc", cwd: h.directory, created: new Date(), modified: new Date(), firstMessage: "" });
	await h.host.readThread({ threadId: "legacy", includeTurns: true });
	assert.equal(await fs.readFile(file, "utf8"), bytes);
});

test("Desktop failures remain failures through the real Pi tool loop", async (t) => {
	const h = await harness(t, { failTool: true });
	h.faux.setResponses([
		h.fauxAssistantMessage([h.fauxToolCall("desktop_echo", {}, { id: "call-failed" })], { stopReason: "toolUse" }),
		h.fauxAssistantMessage("reported failure"),
	]);
	await runTurn(h);
	assert.equal(h.runtime.session.messages.find(m => m.role === "toolResult").isError, true);
	assert.equal(h.sent.find(m => m.method === "item/completed" && m.params.item.id === "call-failed").params.item.success, false);
});

test("SDK-originated continuation creates a visible Desktop turn", async (t) => {
	const h = await harness(t);
	h.faux.setResponses([h.fauxAssistantMessage("first"), h.fauxAssistantMessage("background result")]);
	await runTurn(h);
	h.sent.length = 0;
	await h.runtime.session.sendUserMessage("background completion", { deliverAs: "followUp" });
	await h.runtime.session.waitForIdle();
	assert.equal(h.sent.filter(m => m.method === "turn/started").length, 1);
	assert.equal(h.sent.filter(m => m.method === "turn/completed").length, 1);
	assert.ok(h.sent.some(m => m.method === "item/agentMessage/delta"));
});

test("maintenance waits for session-start hooks before compaction and rolls back without loading stale context", async t => {
	const gate = Promise.withResolvers();
	const entered = Promise.withResolvers();
	let blockStartup = false;
	const order = [];
	const h = await harness(t, { persistent: true, extensionFactories: [pi => {
		pi.on("session_start", async () => {
			if (blockStartup) { order.push("startup-enter"); entered.resolve(); await gate.promise; order.push("startup-ready"); }
		});
		pi.on("session_before_compact", () => {
			order.push("compact-gate");
			return { cancel: true };
		});
	}] });
	h.faux.setResponses([h.fauxAssistantMessage("one"), h.fauxAssistantMessage("two")]);
	await runTurn(h, "first");
	await runTurn(h, "second");
	await h.host.disposeThread(h.thread.id);
	const create = h.host.createServices;
	h.host.createServices = async cwd => {
		const services = await create(cwd);
		services.settingsManager.applyOverrides({ compaction: { enabled: false, keepRecentTokens: 1 } });
		return services;
	};
	blockStartup = true;
	const before = h.faux.state.callCount;
	const compact = h.host.handle({ id: "compact-cold", method: "thread/compact/start", params: { threadId: h.thread.id } });
	try {
		await entered.promise;
		// Give the operation a chance to proceed while initialization is blocked.
		await new Promise(resolve => setTimeout(resolve, 40));
		assert.deepEqual(order, ["startup-enter"], "compaction must not overtake session_start");
		assert.ok(!h.sent.some(m => m.id === "compact-cold"));
	} finally { gate.resolve(); await compact; }
	assert.deepEqual(order, ["startup-enter", "startup-ready", "compact-gate"], JSON.stringify(h.sent.find(m => m.id === "compact-cold")));
	assert.match(h.sent.find(m => m.id === "compact-cold").error.message, /cancelled/);
	assert.equal(h.faux.state.callCount, before);
	await h.host.rollbackThread({ threadId: h.thread.id, numTurns: 1 });
	assert.equal((await h.host.listTurns({ threadId: h.thread.id })).data.length, 1);
});

test("revert and rollback report extension cancellation instead of pretending the branch changed", async t => {
	let cancel = true;
	const h = await harness(t, { persistent: true, extensionFactories: [pi => {
		pi.on("session_before_tree", () => cancel ? { cancel: true } : undefined);
	}] });
	h.faux.setResponses([h.fauxAssistantMessage("one"), h.fauxAssistantMessage("two"), h.fauxAssistantMessage("new branch")]);
	await runTurn(h, "first");
	const second = await runTurn(h, "second");
	const original = await fs.readFile(h.runtime.session.sessionFile, "utf8");
	for (const [method, params] of [
		["thread/revert", { beforeTurnId: second.id }],
		["thread/rollback", { numTurns: 1 }],
	]) {
		await assert.rejects(h.host.dispatch(method, { threadId: h.thread.id, ...params }), /cancelled/);
		assert.equal((await h.host.listTurns({ threadId: h.thread.id })).data.length, 2);
		assert.equal(await fs.readFile(h.runtime.session.sessionFile, "utf8"), original);
	}
	cancel = false;
	await h.host.rollbackThread({ threadId: h.thread.id, numTurns: 1 });
	assert.equal((await h.host.listTurns({ threadId: h.thread.id })).data.length, 1);
	await runTurn(h, "replacement question");
	const file = h.runtime.session.sessionFile;
	await h.host.disposeThread(h.thread.id);
	const restored = await h.host.resumeThread({ threadId: h.thread.id });
	assert.equal(restored.thread.turns.length, 2);
	assert.equal(restored.thread.turns.at(-1).items.at(-1).text, "new branch");
	assert.ok((await fs.readFile(file, "utf8")).startsWith(original), "native branching preserves old entries");
});

test("cold maintenance initialization failures release their lease without changing the conversation", async t => {
	const h = await harness(t, { persistent: true });
	h.faux.setResponses([h.fauxAssistantMessage("history")]);
	const turn = await runTurn(h);
	const file = h.runtime.session.sessionFile;
	await h.host.disposeThread(h.thread.id);
	// SDK hook exceptions are reported, not rejected; force rejection at the
	// adapter's async binding seam to exercise resource cleanup, not hook policy.
	h.host.bindRuntimeExtensions = async () => { throw Error("fixture binding failure"); };
	const bytes = await fs.readFile(file, "utf8");
	const messages = JSON.parse(JSON.stringify(h.runtime.session.messages));
	for (const [method, params] of [["thread/compact/start", {}], ["thread/revert", { beforeTurnId: turn.id }], ["thread/rollback", { numTurns: 1 }]]) {
		await assert.rejects(h.host.dispatch(method, { threadId: h.thread.id, ...params }), /fixture binding failure/);
		assert.equal(h.host.threads.size, 0);
		assert.ok(!fsSync.existsSync(`${file}.desktop-lock`));
		// Runtime creation may append SDK/adapter metadata before binding fails;
		// it must not alter conversation messages, compact or move the branch.
		assert.deepEqual(h.sdk.SessionManager.open(file).buildSessionContext().messages, messages);
		assert.ok((await fs.readFile(file, "utf8")).startsWith(bytes));
	}
});

test("manual compaction completes the native GUI placeholder and restores one matching history card", async t => {
	const h = await harness(t, { persistent: true, extensionFactories: [pi => {
		pi.on("session_before_compact", event => ({ compaction: {
			summary: "GUI SUMMARY", firstKeptEntryId: event.preparation.firstKeptEntryId,
			tokensBefore: event.preparation.tokensBefore,
		} }));
	}] });
	h.runtime.services.settingsManager.applyOverrides({ compaction: { enabled: false, keepRecentTokens: 1 } });
	h.faux.setResponses([h.fauxAssistantMessage("one"), h.fauxAssistantMessage("two")]);
	await runTurn(h, "first");
	await runTurn(h, "second");
	h.sent.length = 0;
	await h.host.compactThread({ threadId: h.thread.id });
	const started = h.sent.filter(m => m.method === "item/started" && m.params.item.type === "contextCompaction");
	assert.equal(started.length, 1, "GUI consumes its pending compaction on item/started");
	const completed = h.sent.filter(m => m.method === "item/completed" && m.params.item.type === "contextCompaction");
	assert.equal(completed.length, 1);
	assert.equal(started[0].params.item.id, completed[0].params.item.id);
	const end = h.sent.find(m => m.method === "turn/completed").params.turn;
	assert.equal(end.id, started[0].params.turnId);
	assert.equal(end.status, "completed");
	assert.equal(h.faux.state.callCount, 2);
	await h.host.disposeThread(h.thread.id);
	const { thread } = await h.host.resumeThread({ threadId: h.thread.id });
	assert.equal(thread.turns.at(-1).id, end.id);
	assert.deepEqual(thread.turns.at(-1).items, end.items);
	assert.equal(thread.turns.flatMap(t => t.items).filter(i => i.type === "contextCompaction").length, 1);
	await h.host.rollbackThread({ threadId: h.thread.id, numTurns: 1 });
	await h.host.disposeThread(h.thread.id);
	const rolledBack = await h.host.resumeThread({ threadId: h.thread.id });
	assert.equal(rolledBack.thread.turns.length, 2);
	assert.ok(rolledBack.thread.turns.flatMap(t => t.items).every(i => i.type !== "contextCompaction"));
});

test("manual compaction respects its extension gate, stays locked, cancels without persistence and survives a successful reopen", async t => {
	let hold = false;
	const entered = Promise.withResolvers();
	const gate = Promise.withResolvers();
	const h = await harness(t, { persistent: true, extensionFactories: [pi => {
		pi.on("session_before_compact", async event => {
			if (hold) { entered.resolve(); await gate.promise; }
			return { compaction: { summary: "FIXTURE COMPACTION SUMMARY", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
		});
	}] });
	h.runtime.services.settingsManager.applyOverrides({ compaction: { enabled: false, keepRecentTokens: 1 } });
	h.faux.setResponses([h.fauxAssistantMessage("one"), h.fauxAssistantMessage("two")]);
	await runTurn(h, "first");
	await runTurn(h, "second");
	const file = h.runtime.session.sessionFile;
	const bytes = await fs.readFile(file, "utf8");
	hold = true;
	const compact = h.host.compactThread({ threadId: h.thread.id });
	const rejected = assert.rejects(compact, /cancelled/);
	await entered.promise;
	try {
		assert.throws(() => acquireSessionGuard(file), /active writer/);
		const stop = h.host.interruptTurn({ threadId: h.thread.id });
		gate.resolve();
		await stop;
		await rejected;
	} finally { gate.resolve(); }
	assert.equal(await fs.readFile(file, "utf8"), bytes);
	hold = false;
	await h.host.compactThread({ threadId: h.thread.id });
	assert.equal(h.runtime.session.sessionManager.getBranch().findLast(e => e.type === "compaction").summary, "FIXTURE COMPACTION SUMMARY");
	assert.equal(h.faux.state.callCount, 2, "extension compaction does not issue a model call");
	assert.ok((await fs.readFile(file, "utf8")).startsWith(bytes));
	await h.host.disposeThread(h.thread.id);
	await h.host.resumeThread({ threadId: h.thread.id });
	assert.equal(h.host.threads.size, 0);
	const restored = await h.host.requireThread(h.thread.id);
	assert.ok(restored.session.messages.some(m => m.role === "compactionSummary" && m.summary === "FIXTURE COMPACTION SUMMARY"));
});

test("a successful rollback remains selected after disposal without requiring another prompt", async t => {
	const h = await harness(t, { persistent: true });
	h.faux.setResponses([h.fauxAssistantMessage("keep"), h.fauxAssistantMessage("leave branch")]);
	await runTurn(h, "first");
	await runTurn(h, "second");
	const file = h.runtime.session.sessionFile;
	const original = await fs.readFile(file, "utf8");
	await h.host.rollbackThread({ threadId: h.thread.id, numTurns: 1 });
	await h.host.disposeThread(h.thread.id);
	const result = await h.host.resumeThread({ threadId: h.thread.id });
	assert.equal(result.thread.turns.length, 1);
	assert.equal(result.thread.turns[0].items.at(-1).text, "keep");
	await h.host.rollbackThread({ threadId: h.thread.id, numTurns: 1 });
	await h.host.disposeThread(h.thread.id);
	assert.equal((await h.host.resumeThread({ threadId: h.thread.id })).thread.turns.length, 0);
	assert.ok((await fs.readFile(file, "utf8")).startsWith(original), "old branch must not be deleted");
});

test("live turn and item identities survive a JSONL round trip and can be reverted", async (t) => {
	const h = await harness(t);
	h.faux.setResponses([h.fauxAssistantMessage([
		h.fauxThinking("consider"), h.fauxText("answer"),
		h.fauxToolCall("desktop_echo", {}, { id: "roundtrip-tool" }),
	], { stopReason: "toolUse" }), h.fauxAssistantMessage("done")]);
	const turn = await runTurn(h);
	const live = h.sent.find(m => m.method === "turn/completed").params.turn;
	const file = path.join(h.directory, "saved.jsonl");
	await fs.writeFile(file, [h.runtime.session.sessionManager.getHeader(), ...h.runtime.session.sessionManager.getEntries()].map(JSON.stringify).join("\n") + "\n");
	const restored = h.sdk.SessionManager.open(file);
	const history = entriesToTurns(restored.getBranch(), { cwd: h.directory });
	assert.equal(history[0].id, turn.id);
	assert.deepEqual(history[0].items.map(i => i.id), live.items.map(i => i.id));
	assert.equal(history[0].status, live.status);
	await h.host.revertThread({ threadId: h.runtime.id, beforeTurnId: turn.id });
	assert.equal((await h.host.listTurns({ threadId: h.runtime.id })).data.length, 0);
});

test("legacy failed history retains native Bash results and failed turn state", () => {
	const entries = [
		{ type: "message", id: "u", message: { role: "user", content: "run", timestamp: 1 } },
		{ type: "message", id: "a", message: { role: "assistant", content: [{ type: "toolCall", id: "c", name: "bash", arguments: { command: "false" } }], stopReason: "toolUse", timestamp: 2 } },
		{ type: "message", id: "r", message: { role: "toolResult", toolCallId: "c", content: [{ type: "text", text: "failed" }], isError: true, details: { exitCode: 3 }, timestamp: 3 } },
		{ type: "message", id: "e", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "provider failed", timestamp: 4 } },
	];
	const [turn] = entriesToTurns(entries, { cwd: "/tmp/project" });
	assert.equal(turn.status, "failed");
	assert.equal(turn.error.message, "provider failed");
	const command = turn.items.find(i => i.id === "c");
	assert.equal(command.type, "commandExecution");
	assert.equal(command.cwd, "/tmp/project");
	assert.equal(command.exitCode, 3);
	assert.equal(command.aggregatedOutput, "failed");
});

test("archive survives host/store restart and filters active versus archived lists", async (t) => {
	const h = await harness(t);
	const info = { id: "saved", cwd: h.directory, created: new Date(0), modified: new Date(0), firstMessage: "hi" };
	h.host.sdk = { ...h.sdk, SessionManager: { listAll: async () => [info] } };
	await h.host.archiveThread({ threadId: info.id }, true);
	h.host.projectStore = new ProjectStore({ codexHome: h.directory });
	assert.deepEqual((await h.host.listThreads({ archived: false })).data, []);
	assert.deepEqual((await h.host.listThreads({ archived: true })).data.map(t => t.id), [info.id]);
	await h.host.archiveThread({ threadId: info.id }, false);
	assert.equal((await h.host.listThreads({})).data.length, 1);
});

test("shutdown cancels an unanswered startup dialog before waiting for extension binding", async (t) => {
	const h = await harness(t);
	const pending = h.host.askInput("Startup question", undefined, h.runtime);
	h.runtime.ready = pending;
	const shutdown = h.host.shutdown();
	// Always release the fixture even if the regression fails.
	const timer = setTimeout(() => {
		for (const id of h.host.uiRequests.keys()) void h.host.handle({ id, error: { message: "test cleanup" } });
	}, 500);
	try {
		await Promise.race([shutdown, new Promise((_, reject) => setTimeout(() => reject(new Error("shutdown blocked by dialog")), 150))]);
		assert.equal(h.host.uiRequests.size, 0);
	} finally { await shutdown; clearTimeout(timer); }
});

test("unsupported mutations reject instead of reporting success", async (t) => {
	const h = await harness(t);
	for (const method of ["config/value/write", "config/batchWrite", "plugin/install", "plugin/uninstall", "turn/removePendingInput"]) {
		await assert.rejects(h.host.dispatch(method, {}), /not support|not implement/i);
	}
});

test("supported Desktop preferences persist without admitting agent config writes", async (t) => {
	const h = await harness(t);
	await h.host.dispatch("config/batchWrite", { edits: [
		{ keyPath: "desktop.followUpQueueMode", mergeStrategy: "replace", value: "queue" },
		{ keyPath: "desktop.conversationDetailMode", mergeStrategy: "upsert", value: "STEPS_EXECUTION" },
	] });
	h.host.projectStore = new ProjectStore({ codexHome: h.directory });
	assert.deepEqual((await h.host.configRead()).config.desktop, { followUpQueueMode: "queue", conversationDetailMode: "STEPS_EXECUTION" });
	await assert.rejects(h.host.dispatch("config/batchWrite", { edits: [
		{ keyPath: "desktop.followUpQueueMode", mergeStrategy: "replace", value: "steer" },
		{ keyPath: "mcp_servers.node_repl", mergeStrategy: "replace", value: {} },
	] }), /not support/);
	assert.equal((await h.host.configRead()).config.desktop.followUpQueueMode, "queue");
	await assert.rejects(h.host.dispatch("config/value/write", { keyPath: "desktop.__proto__", mergeStrategy: "replace", value: {} }), /not support/);
	await h.host.dispatch("config/value/write", { keyPath: "desktop.followUpQueueMode", mergeStrategy: "replace", value: null });
	assert.equal((await h.host.configRead()).config.desktop.followUpQueueMode, undefined);
});

test("GUI model settings update Pi defaults without admitting unrelated agent config", async (t) => {
	const h = await harness(t);
	await h.host.dispatch("config/batchWrite", {
		filePath: null, expectedVersion: null, reloadUserConfig: true,
		edits: [
			{ keyPath: "model", mergeStrategy: "upsert", value: "desktop-test/faux" },
			{ keyPath: "model_reasoning_effort", mergeStrategy: "upsert", value: "none" },
		],
	});
	const config = (await h.host.configRead()).config;
	assert.equal(config.model, "desktop-test/faux");
	assert.equal(config.model_reasoning_effort, "off");
	await assert.rejects(h.host.dispatch("config/batchWrite", { edits: [
		{ keyPath: "model", mergeStrategy: "replace", value: "desktop-test/faux" },
		{ keyPath: "model_reasoning_effort", mergeStrategy: "replace", value: "high" },
		{ keyPath: "mcp_servers.node_repl", mergeStrategy: "replace", value: {} },
	] }), /not support/);
	const unchanged = (await h.host.configRead()).config;
	assert.equal(unchanged.model, "desktop-test/faux");
	assert.equal(unchanged.model_reasoning_effort, "off");
});

test("Codex collaboration settings select the model and translate off reasoning", async (t) => {
	const h = await harness(t);
	const selected = h.runtime.session.model;
	const changes = [];
	h.host.resolveModel = (_services, id) => { changes.push(id); return selected; };
	h.runtime.session.setThinkingLevel = value => changes.push(value);
	await h.host.applyModelSettings(h.runtime, { model: null, effort: null,
		collaborationMode: { settings: { model: "desktop-test/faux", reasoning_effort: "off" } },
	});
	assert.deepEqual(changes, ["desktop-test/faux", "off"]);
});

test("resume reuses a loaded session instead of aborting its active work", async (t) => {
	const h = await harness(t);
	let aborts = 0;
	h.runtime.session.abort = async () => { aborts++; };
	h.runtime.activeTurnId = "turn-running";
	const resumed = await h.host.resumeThread({ threadId: h.runtime.id, excludeTurns: false });
	assert.equal(h.host.threads.get(h.runtime.id), h.runtime);
	assert.equal(resumed.thread.status.type, "active");
	assert.equal(aborts, 0);
});

test("archive stops and unloads the session before persisting archive state", async (t) => {
	const h = await harness(t);
	await h.host.archiveThread({ threadId: h.runtime.id }, true);
	assert.equal(h.host.threads.has(h.runtime.id), false);
	assert.ok((await h.host.projectStore.snapshot()).archivedThreads.includes(h.runtime.id));
});

test("Stop during preparation prevents the pending prompt from starting", async (t) => {
	const h = await harness(t);
	let release;
	h.runtime.ready = new Promise(resolve => { release = resolve; });
	const starting = h.host.startTurn({ threadId: h.runtime.id, input: [{ type: "text", text: "do not run" }] });
	await new Promise(resolve => setImmediate(resolve));
	await h.host.interruptTurn({ threadId: h.runtime.id });
	release();
	await assert.rejects(starting, /interrupted/);
	assert.equal(h.faux.state.callCount, 0);
});

test("preflight failures retain submitted input in live and restored display only", async (t) => {
	const h = await harness(t);
	h.runtime.session.prompt = async () => { throw new Error("preflight failed"); };
	await runTurn(h, "keep this input");
	const live = h.sent.find(m => m.method === "turn/completed").params.turn;
	const [saved] = entriesToTurns(h.runtime.session.sessionManager.getBranch());
	assert.equal(live.items[0].content[0].text, "keep this input");
	assert.deepEqual(saved.items, live.items);
	assert.equal(saved.status, "failed");
	assert.equal(h.runtime.session.messages.length, 0);
});

test("a pending Desktop tool can be interrupted without hanging or continuing queued work", async (t) => {
	const h = await harness(t);
	h.host.send = (message) => h.sent.push(structuredClone(message));
	h.faux.setResponses([h.fauxAssistantMessage([h.fauxToolCall("desktop_echo", {}, { id: "pending" })], { stopReason: "toolUse" })]);
	const started = await h.host.startTurn({ threadId: h.runtime.id, input: [{ type: "text", text: "call tool" }] });
	const deadline = Date.now() + 3000;
	while (!h.host.dynamicCalls.size) {
		if (Date.now() > deadline) throw new Error("tool callback never arrived");
		await new Promise(resolve => setTimeout(resolve, 5));
	}
	assert.equal((await h.host.listTurns({ threadId: h.runtime.id })).data.at(-1).status, "inProgress");
	await h.runtime.session.followUp("do not execute after Stop");
	await h.host.interruptTurn({ threadId: h.runtime.id, turnId: started.turn.id });
	assert.equal(h.host.dynamicCalls.size, 0);
	assert.equal(h.runtime.session.pendingMessageCount, 0);
	assert.equal(h.runtime.activeTurnId, null);
	assert.equal(h.sent.filter(m => m.method === "turn/completed").length, 1);
});

test("explicit Stop remains interrupted when a provider reports cancellation as an error", async t => {
	const h = await harness(t);
	h.host.send = message => h.sent.push(structuredClone(message));
	h.faux.setResponses([
		h.fauxAssistantMessage([h.fauxToolCall("desktop_echo", {}, { id: "stop-error" })], { stopReason: "toolUse" }),
		h.fauxAssistantMessage("after cancelled tool"),
	]);
	const { turn } = await h.host.startTurn({ threadId: h.runtime.id, input: [{ type: "text", text: "stop at tool" }] });
	const deadline = Date.now() + 3000;
	while (!h.host.dynamicCalls.size) {
		if (Date.now() > deadline) throw Error("fixture tool did not start");
		await new Promise(resolve => setTimeout(resolve, 5));
	}
	await h.host.interruptTurn({ threadId: h.runtime.id, turnId: turn.id });
	const completed = h.sent.find(m => m.method === "turn/completed").params.turn;
	assert.equal(completed.status, "interrupted");
	assert.equal(completed.error, null);
	const saved = (await h.host.listTurns({ threadId: h.runtime.id })).data.at(-1);
	assert.equal(saved.status, "interrupted");
	assert.equal(saved.error, null);
	// An unrelated later provider failure must not inherit the previous Stop.
	h.sent.length = 0;
	h.faux.setResponses([h.fauxAssistantMessage("", { stopReason: "error", errorMessage: "fixture provider failure" })]);
	await runTurn(h, "next turn");
	assert.equal(h.sent.find(m => m.method === "turn/completed").params.turn.status, "failed");
});

test("real SDK Bash completes offline while controller is gone and reattaches with stable history", async t => {
	const h = await harness(t);
	const owner = await servePersistentHost(h.host, path.join(h.directory, "owner.sock"));
	t.after(() => owner.close());
	async function connect() {
		const socket = net.createConnection(path.join(h.directory, "owner.sock"));
		const messages = []; let buffer = "";
		socket.setEncoding("utf8"); socket.on("data", chunk => {
			buffer += chunk; for (let end; (end = buffer.indexOf("\n")) >= 0;) {
				messages.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1);
			}
		});
		await once(socket, "connect");
		return { socket, messages };
	}
	const a = await connect();
	h.faux.setResponses([
		h.fauxAssistantMessage([h.fauxToolCall("bash", { command: "sleep 0.2; printf PERSISTENT_TOOL_OK" }, { id: "offline-bash" })], { stopReason: "toolUse" }),
		h.fauxAssistantMessage("PERSISTENT_REPLY_OK"),
	]);
	a.socket.write(JSON.stringify({ id: 1, method: "turn/start", params: { threadId: h.runtime.id, input: [{ type: "text", text: "fixture only" }] } }) + "\n");
	const deadline = Date.now() + 3000;
	while (!h.runtime.activeTools.size) { if (Date.now() > deadline) throw Error("Bash never started"); await new Promise(r => setTimeout(r, 5)); }
	a.socket.destroy(); await once(a.socket, "close");
	await h.runtime.session.waitForIdle();
	assert.equal(h.runtime.session.messages.find(m => m.role === "toolResult").content[0].text, "PERSISTENT_TOOL_OK");
	const b = await connect();
	b.socket.write(JSON.stringify({ id: 1, method: "thread/resume", params: { threadId: h.runtime.id } }) + "\n");
	while (!b.messages.find(m => m.id === 1)) { if (Date.now() > deadline) throw Error("resume timed out"); await new Promise(r => setTimeout(r, 5)); }
	const result = b.messages.find(m => m.id === 1).result;
	assert.equal(result.thread.turns.at(-1).status, "completed");
	assert.equal(result.thread.turns.at(-1).items.at(-1).text, "PERSISTENT_REPLY_OK");
	assert.equal(h.faux.state.callCount, 2);
	// Shutdown must revoke unanswered consent; a reconnect never inherits approval.
	const pendingApproval = h.host.askConfirm("Guard", "Permit?", h.runtime);
	b.socket.destroy();
	assert.equal(await pendingApproval, false);
	assert.equal(await h.host.askConfirm("Offline", "Permit?", h.runtime), false);
});

test("persistent approval detach denies old consent; reconnect resolves its UI identity and rejects stale replies", async t => {
	const h = await harness(t);
	const owner = await servePersistentHost(h.host, path.join(h.directory, "approval.sock"));
	const sockets = [];
	async function connect() {
		const socket = net.createConnection(path.join(h.directory, "approval.sock"));
		sockets.push(socket);
		let buffer = "";
		const messages = [];
		socket.setEncoding("utf8");
		socket.on("data", chunk => {
			buffer += chunk;
			for (let end; (end = buffer.indexOf("\n")) >= 0;) {
				messages.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1);
			}
		});
		await once(socket, "connect");
		return { socket, messages, send: message => socket.write(JSON.stringify(message) + "\n") };
	}
	async function until(predicate) {
		const deadline = Date.now() + 3000;
		while (!predicate()) { if (Date.now() > deadline) throw Error("approval fixture timed out"); await new Promise(r => setTimeout(r, 5)); }
	}
	try {
		const a = await connect();
		const consent = h.host.askConfirm("Old consent", "Allow?", h.runtime);
		await until(() => a.messages.some(m => m.method === "item/tool/requestUserInput"));
		const old = a.messages.find(m => m.method === "item/tool/requestUserInput");
		a.socket.destroy();
		assert.equal(await consent, false);
		const b = await connect();
		b.send({ id: "resume", method: "thread/resume", params: { threadId: h.runtime.id } });
		await until(() => b.messages.some(m => m.method === "serverRequest/resolved" && m.params.requestId === old.id));
		assert.equal(h.host.threads.get(h.runtime.id), h.runtime, "detach preserves runtime");
		let settled = false;
		const nextConsent = h.host.askConfirm("New consent", "Allow?", h.runtime).then(value => { settled = true; return value; });
		await until(() => b.messages.some(m => m.method === "item/tool/requestUserInput"));
		const next = b.messages.find(m => m.method === "item/tool/requestUserInput");
		assert.notEqual(next.id, old.id);
		b.send({ id: old.id, result: { answers: { choice: { answers: ["Yes"] } } } });
		// Ordered request acts as a drain barrier after the stale reply.
		b.send({ id: "barrier", method: "thread/read", params: { threadId: h.runtime.id } });
		await until(() => b.messages.some(m => m.id === "barrier"));
		assert.equal(settled, false);
		b.send({ id: next.id, result: { answers: { choice: { answers: ["No"] } } } });
		assert.equal(await nextConsent, false);
	} finally {
		for (const socket of sockets) socket.destroy();
		await owner.close();
	}
});

test("session guard rejects another Desktop writer and detects uncooperative external writes", async (t) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-desktop-session-guard-"));
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	const file = path.join(directory, "session.jsonl");
	await fs.writeFile(file, "header\n");
	const warnings = [];
	const guard = acquireSessionGuard(file, message => warnings.push(message));
	t.after(() => { try { guard.release(); } catch {} });
	const manager = {
		_appendEntry(value) { fsSync.appendFileSync(file, value); },
		_rewriteFile() { fsSync.writeFileSync(file, "rewrite\n"); },
	};
	guard.bind(manager);
	manager._appendEntry("owned\n");
	assert.throws(() => acquireSessionGuard(file), /in use/);
	await fs.appendFile(file, "external\n");
	assert.throws(() => manager._appendEntry("unsafe\n"), /changed by another client/);
	assert.match((await fs.readFile(file, "utf8")), /external\n$/);
	assert.equal(warnings.length, 1);
});

test("separate metadata writers reload state and refuse an occupied lock", async (t) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-desktop-store-"));
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	const a = new ProjectStore({ codexHome: directory });
	const b = new ProjectStore({ codexHome: directory });
	await Promise.all([a.snapshot(), b.snapshot()]);
	await a.create({ name: "A", idempotencyKey: "a" });
	await b.create({ name: "B", idempotencyKey: "b" });
	assert.deepEqual((await a.snapshot()).projects.map(p => p.name), ["A", "B"]);
	await fs.writeFile(`${a.filePath}.lock`, "external owner");
	await assert.rejects(a.setArchived("session", true), /locked/);
	assert.equal(await fs.readFile(`${a.filePath}.lock`, "utf8"), "external owner");
});

test("custom extension wakeups and interrupted turns retain identities and terminal state", async (t) => {
	const h = await harness(t);
	h.faux.setResponses([h.fauxAssistantMessage("custom wakeup")]);
	await h.runtime.session.sendCustomMessage({ customType: "completion", content: "child finished", display: true }, { triggerTurn: true });
	const completed = h.sent.find(m => m.method === "turn/completed").params.turn;
	const history = entriesToTurns(h.runtime.session.sessionManager.getBranch());
	assert.equal(history[0].id, completed.id);
	assert.deepEqual(history[0].items.map(i => i.id), completed.items.map(i => i.id));
	assert.equal(history[0].items[0].text, "child finished");

	h.faux.setResponses([h.fauxAssistantMessage("cancelled", { stopReason: "aborted" })]);
	await runTurn(h);
	assert.equal(entriesToTurns(h.runtime.session.sessionManager.getBranch()).at(-1).status, "interrupted");
});

test("an unfinished projection is not restored as a successful turn", () => {
	const [turn] = entriesToTurns([
		{ type: "custom", customType: "codex-app-pi.turn", id: "meta", data: { id: "turn-live", status: "interrupted" } },
		{ type: "message", id: "a", message: { role: "assistant", content: [], stopReason: "toolUse" } },
	]);
	assert.equal(turn.status, "interrupted");
});

test("CLI continuation after a crashed Desktop turn starts a separate legacy turn", () => {
	const turns = entriesToTurns([
		{ type: "custom", customType: "codex-app-pi.turn", id: "meta", data: { id: "turn-crashed", status: "interrupted" } },
		{ type: "custom", customType: "codex-app-pi.item", id: "map", data: { user: "live-user" } },
		{ type: "message", id: "u1", message: { role: "user", content: "desktop" } },
		{ type: "message", id: "u2", message: { role: "user", content: "cli continuation" } },
	]);
	assert.deepEqual(turns.map(turn => turn.id), ["turn-crashed", "turn-u2"]);
	assert.equal(turns[0].status, "interrupted");
});

test("cached file extensions and inline extensions share only their own loader bus", async (t) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-desktop-bus-test-"));
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	const sdk = await loadPiSdk();
	await fs.mkdir(path.join(directory, "extensions"));
	await fs.writeFile(path.join(directory, "extensions", "probe.ts"), `
		export default function(pi) {
			let count = 0;
			pi.events.on('review-probe', request => { request.count = ++count; });
		}
	`);
	const buses = [];
	for (let i = 0; i < 2; i++) {
		const bus = sdk.createEventBus();
		buses.push(bus);
		const loader = new sdk.DefaultResourceLoader({
			cwd: directory, agentDir: directory, eventBus: bus,
			settingsManager: sdk.SettingsManager.inMemory(),
			noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true,
			extensionFactories: [(pi) => pi.events.on('review-inline-probe', request => pi.events.emit('review-probe', request))],
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
	}
	for (const bus of buses) {
		const request = {};
		bus.emit('review-inline-probe', request);
		assert.equal(request.count, 1);
		bus.clear();
	}
});

test("app-server drains piped requests before EOF shutdown", async (t) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-desktop-eof-test-"));
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
		import { spawn } from 'node:child_process';
		const child = spawn(process.execPath, ['pi-app-server.mjs'], { stdio: ['pipe', 'inherit', 'inherit'] });
		child.stdin.end(JSON.stringify({id:1,method:'initialize'})+'\\n'+JSON.stringify({id:2,method:'model/list'})+'\\n');
		child.on('exit', code => process.exit(code ?? 1));
	`], {
		cwd: path.resolve(import.meta.dirname, ".."), timeout: 10000,
		env: { ...process.env, PI_CODING_AGENT_DIR: directory, CODEX_HOME: directory, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
	});
	const responses = stdout.trim().split("\n").map(JSON.parse);
	assert.deepEqual(responses.map(r => r.id), [1, 2]);
	assert.ok(responses.every(r => r.result));
});

test("section and subagent filters never return unrelated native Pi sessions", async (t) => {
	const h = await harness(t);
	const info = { id: 'native', cwd: h.directory, created: new Date(0), modified: new Date(0), firstMessage: 'existing' };
	h.host.sdk = { ...h.sdk, SessionManager: { listAll: async () => [info] } };
	assert.equal((await h.host.listThreads({})).data.length, 1);
	assert.deepEqual((await h.host.listThreads({ sectionId: '01984de2-8f74-7c91-a3b2-5c5e937cf318' })).data, []);
	assert.deepEqual((await h.host.listThreads({ sourceKinds: ['subAgentThreadSpawn'], parentThreadId: 'parent' })).data, []);
});

test("catalog and session services have independent event buses", async () => {
	const buses = [];
	const sdk = { getAgentDir: () => "/tmp/unused", ProjectTrustStore: class { get() { return false; } },
		createEventBus: () => ({}), SettingsManager: { create: () => ({}) },
		createAgentSessionServices: async ({ resourceLoaderOptions }) => { buses.push(resourceLoaderOptions.eventBus); return {}; },
	};
	const host = new PiHost({ sdk, send() {} });
	await host.ensureCatalogServices();
	await host.createServices("/tmp/a");
	await host.createServices("/tmp/b");
	assert.equal(new Set(buses).size, 3);
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PiHost } from "../src/pi-host.mjs";

function fakeHost({ sessions = [], codexHome } = {}) {
	const sent = [];
	const sdk = {
		getAgentDir: () => "/tmp/pi-agent",
		SessionManager: {
			listAll: async () => sessions,
		},
		createEventBus: () => ({
			emit() {},
			on() {
				return () => {};
			},
			clear() {},
		}),
		ProjectTrustStore: class {
			get() {
				return true;
			}
		},
		outputGuard: { writeRawStdout() {} },
	};
	return {
		sent,
		host: new PiHost({
			sdk,
			send: (message) => sent.push(message),
			cwd: "/tmp/project",
			piVersion: "test",
			codexHome,
		}),
	};
}

function fakeRuntime() {
	return {
		id: "thread-1",
		cwd: "/tmp/project",
		activeTurnId: "turn-1",
		turnStartedAt: Date.now(),
		currentItems: [],
		activeTools: new Map(),
		toolOutput: new Map(),
		assistantItemId: null,
		reasoningItemId: null,
		dynamicTools: [],
		session: {
			messages: [],
			model: { id: "model", provider: "provider", contextWindow: 1000 },
			getSessionStats: () => ({ tokens: {} }),
		},
	};
}

test("streaming text becomes one started item, deltas, then one completed item", () => {
	const { host, sent } = fakeHost();
	const runtime = fakeRuntime();
	host.onMessageUpdate(runtime, {
		assistantMessageEvent: { type: "text_start", contentIndex: 0 },
	});
	host.onMessageUpdate(runtime, {
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" },
	});
	host.onMessageEnd(runtime, {
		role: "assistant",
		content: [{ type: "text", text: "hello" }],
		usage: { input: 1, output: 1, totalTokens: 2 },
	});
	assert.deepEqual(
		sent.map((message) => message.method),
		["item/started", "item/agentMessage/delta", "item/completed", "thread/tokenUsage/updated"],
	);
	assert.equal(sent[1].params.delta, "hello");
	assert.equal(sent[2].params.item.text, "hello");
});

test("multiple assistant messages in one Pi run get separate Desktop items", () => {
	const { host, sent } = fakeHost();
	const runtime = fakeRuntime();
	for (const text of ["before tool", "after tool"]) {
		host.onMessageUpdate(runtime, {
			assistantMessageEvent: { type: "text_start", contentIndex: 0 },
		});
		host.onMessageEnd(runtime, {
			role: "assistant",
			content: [{ type: "text", text }],
			usage: {},
		});
	}
	const completed = sent.filter((message) => message.method === "item/completed");
	assert.equal(completed.length, 2);
	assert.notEqual(completed[0].params.item.id, completed[1].params.item.id);
});

test("unknown Pi extension tools use the generic dynamic tool card", () => {
	const { host, sent } = fakeHost();
	const runtime = fakeRuntime();
	host.onToolStart(runtime, {
		toolCallId: "tool-1",
		toolName: "future_plugin_tool",
		args: { value: 1 },
	});
	host.onToolEnd(runtime, {
		toolCallId: "tool-1",
		toolName: "future_plugin_tool",
		result: { content: [{ type: "text", text: "done" }] },
		isError: false,
	});
	assert.equal(sent[0].params.item.type, "dynamicToolCall");
	assert.equal(sent[0].params.item.tool, "future_plugin_tool");
	assert.equal(sent[1].params.item.success, true);
	assert.equal(sent[1].params.item.contentItems[0].text, "done");
});

test("bash is rendered as a native command execution card", () => {
	const { host, sent } = fakeHost();
	const runtime = fakeRuntime();
	host.onToolStart(runtime, {
		toolCallId: "bash-1",
		toolName: "bash",
		args: { command: "printf ok" },
	});
	host.onToolEnd(runtime, {
		toolCallId: "bash-1",
		toolName: "bash",
		result: {
			content: [{ type: "text", text: "ok" }],
			details: { exitCode: 0 },
		},
		isError: false,
	});
	assert.equal(sent[0].params.item.type, "commandExecution");
	assert.equal(sent[1].params.item.status, "completed");
	assert.equal(sent[1].params.item.aggregatedOutput, "ok");
});

test("agent settled completes and clears the active Desktop turn", () => {
	const { host, sent } = fakeHost();
	const runtime = fakeRuntime();
	host.completeTurn(runtime);
	assert.equal(sent[0].method, "turn/completed");
	assert.equal(sent[0].params.turn.status, "completed");
	assert.equal(runtime.activeTurnId, null);
});

test("importing a project exposes its existing Pi sessions in project-filtered thread lists", async (t) => {
	const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-app-pi-projects-"));
	t.after(() => fs.rm(codexHome, { recursive: true, force: true }));
	const projectRoot = path.join(codexHome, "existing-project");
	const otherRoot = path.join(codexHome, "other-project");
	const sessions = [
		{
			id: "existing-project-session",
			name: "Existing project session",
			firstMessage: "existing project history",
			cwd: projectRoot,
			path: path.join(codexHome, "existing.jsonl"),
			created: "2026-01-01T00:00:00.000Z",
			modified: "2026-01-02T00:00:00.000Z",
		},
		{
			id: "other-project-session",
			name: "Other project session",
			firstMessage: "other project history",
			cwd: otherRoot,
			path: path.join(codexHome, "other.jsonl"),
			created: "2026-01-01T00:00:00.000Z",
			modified: "2026-01-03T00:00:00.000Z",
		},
	];
	const { host } = fakeHost({ sessions, codexHome });

	const imported = await host.dispatch("project/import", {
		name: "existing-project",
		roots: [{ path: projectRoot }],
		threads: null,
		idempotencyKey: "existing-project-import",
	});
	const listed = await host.dispatch("thread/list", {
		projectId: imported.project.id,
		limit: 100,
	});

	assert.deepEqual(listed.data.map((thread) => thread.id), ["existing-project-session"]);
	assert.equal(listed.data[0].projectId, imported.project.id);
});

test("initialize advertises project protocol support without changing Pi thread versions", async (t) => {
	const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-app-pi-version-"));
	t.after(() => fs.rm(codexHome, { recursive: true, force: true }));
	const sessions = [
		{
			id: "history-thread",
			name: null,
			firstMessage: "history",
			cwd: "/tmp/project",
			path: "/tmp/history.jsonl",
			created: "2026-01-01T00:00:00.000Z",
			modified: "2026-01-02T00:00:00.000Z",
		},
	];
	const { host } = fakeHost({ sessions, codexHome });

	const initialized = await host.dispatch("initialize", {});
	const listed = await host.dispatch("thread/list", { limit: 10 });

	assert.equal(initialized.userAgent, "pi-codex/0.148.0-alpha.21");
	assert.equal(listed.data[0].cliVersion, "test");
});

test("thread metadata updates persist explicit project assignment and clearing", async (t) => {
	const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-app-pi-metadata-"));
	t.after(() => fs.rm(codexHome, { recursive: true, force: true }));
	const projectRoot = path.join(codexHome, "project");
	const sessions = [
		{
			id: "history-thread",
			name: null,
			firstMessage: "history",
			cwd: projectRoot,
			path: path.join(codexHome, "history.jsonl"),
			created: "2026-01-01T00:00:00.000Z",
			modified: "2026-01-02T00:00:00.000Z",
		},
	];
	const { host, sent } = fakeHost({ sessions, codexHome });
	const imported = await host.dispatch("project/import", {
		name: "project",
		roots: [{ path: projectRoot }],
		idempotencyKey: "project-import",
	});

	const assigned = await host.dispatch("thread/metadata/update", {
		threadId: "history-thread",
		projectId: imported.project.id,
	});
	const cleared = await host.dispatch("thread/metadata/update", {
		threadId: "history-thread",
		projectId: "",
	});
	const projectThreads = await host.dispatch("thread/list", {
		projectId: imported.project.id,
		limit: 10,
	});
	const projectlessThreads = await host.dispatch("thread/list", {
		projectId: null,
		limit: 10,
	});

	assert.equal(assigned.thread.projectId, imported.project.id);
	assert.equal(cleared.thread.projectId, null);
	assert.deepEqual(projectThreads.data, []);
	assert.deepEqual(projectlessThreads.data.map((thread) => thread.id), ["history-thread"]);
	assert.ok(
		sent.some(
			(message) =>
				message.method === "thread/project/updated" &&
				message.params.threadId === "history-thread" &&
				message.params.projectId === null,
		),
	);
});

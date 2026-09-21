import assert from "node:assert/strict";
import test from "node:test";
import {
	blankThread,
	codexResultToPi,
	entriesToTurns,
	flattenDynamicTools,
	inputToPi,
	modelToCodex,
	splitStrictJsonLines,
	threadFromSessionInfo,
	usageBreakdown,
} from "../src/protocol.mjs";

test("strict JSONL framing ignores Unicode line separators", () => {
	const lines = [];
	const feed = splitStrictJsonLines((line) => lines.push(line));
	feed('{"text":"a\u2028b"}\r');
	feed('\n{"ok":true}\n');
	assert.deepEqual(lines, ['{"text":"a\u2028b"}', '{"ok":true}']);
});

test("dynamic tool namespaces flatten without changing tool schemas", () => {
	assert.deepEqual(
		flattenDynamicTools([
			{
				type: "namespace",
				name: "codex_app",
				tools: [
					{
						type: "function",
						name: "send_message",
						description: "Send",
						inputSchema: { type: "object", properties: { text: { type: "string" } } },
					},
				],
			},
		]),
		[
			{
				name: "send_message",
				namespace: "codex_app",
				description: "Send",
				inputSchema: { type: "object", properties: { text: { type: "string" } } },
			},
		],
	);
});

test("Codex input maps to Pi text, images, and file mentions", () => {
	const result = inputToPi([
		{ type: "text", text: "hello" },
		{ type: "mention", name: "file", path: "/tmp/a.txt" },
		{ type: "image", url: "data:image/png;base64,YQ==" },
	]);
	assert.equal(result.text, "hello\n@/tmp/a.txt");
	assert.deepEqual(result.images, [{ type: "image", mimeType: "image/png", data: "YQ==" }]);
});

test("Pi models preserve provider identity in the Desktop model id", () => {
	const result = modelToCodex({
		provider: "local",
		id: "vendor/model",
		name: "Model",
		reasoning: true,
		input: ["text"],
		contextWindow: 1234,
		thinkingLevelMap: { off: "off", high: "high", max: "max" },
	});
	assert.equal(result.id, "local/vendor/model");
	assert.equal(result.model, "local/vendor/model");
	assert.equal(result.modelProviderId, "local");
	assert.equal(result.contextWindow, 1234);
	assert.ok(result.supportedReasoningEfforts.some((entry) => entry.reasoningEffort === "max"));
});

test("reasoning efforts use canonical ascending order regardless of provider map order", () => {
	const result = modelToCodex({
		provider: "local",
		id: "unordered",
		name: "Unordered",
		reasoning: true,
		input: ["text"],
		contextWindow: 1234,
		thinkingLevelMap: { high: "high", low: "low", max: "max", medium: "medium", minimal: "minimal", off: "off", xhigh: "xhigh" },
	});
	assert.deepEqual(result.supportedReasoningEfforts.map((entry) => entry.reasoningEffort),
		["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
});

test("session entries map to stable Codex turn and item ids", () => {
	const entries = [
		{
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: { role: "user", content: "hi", timestamp: 1 },
		},
		{
			type: "message",
			id: "a1",
			parentId: "u1",
			timestamp: "2026-01-01T00:00:01.000Z",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "think" },
					{ type: "text", text: "hello" },
					{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a" } },
				],
				timestamp: 2,
				usage: {},
				stopReason: "toolUse",
			},
		},
		{
			type: "message",
			id: "r1",
			parentId: "a1",
			timestamp: "2026-01-01T00:00:02.000Z",
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: 3,
			},
		},
	];
	const first = entriesToTurns(entries);
	const second = entriesToTurns(entries);
	assert.deepEqual(first, second);
	assert.equal(first[0].id, "turn-u1");
	assert.equal(first[0].items[0].id, "u1");
	assert.deepEqual(first[0].items[0].content[0].text_elements, []);
	const tool = first[0].items.find((item) => item.id === "call-1");
	assert.equal(tool.success, true);
});

test("usage and Desktop tool results retain cache and error information", () => {
	assert.deepEqual(
		usageBreakdown({
			input: 10,
			output: 5,
			cacheRead: 7,
			cacheWrite: 3,
			reasoning: 2,
			totalTokens: 15,
		}),
		{
			inputTokens: 10,
			outputTokens: 5,
			cachedInputTokens: 7,
			cacheCreationInputTokens: 3,
			reasoningOutputTokens: 2,
			totalTokens: 15,
		},
	);
	const result = codexResultToPi({
		success: false,
		contentItems: [{ type: "inputText", text: "failed" }],
	});
	assert.equal(result.isError, true);
	assert.equal(result.content[0].text, "failed");
});

test("historical and loaded thread objects expose canonical project ids", () => {
	const info = {
		id: "history-thread",
		firstMessage: "hello",
		name: null,
		cwd: "/tmp/project",
		path: "/tmp/history.jsonl",
		created: "2026-01-01T00:00:00.000Z",
		modified: "2026-01-02T00:00:00.000Z",
	};
	assert.equal(threadFromSessionInfo(info, "test", [], "project-1").projectId, "project-1");
	assert.equal(
		blankThread({
			id: "loaded-thread",
			cwd: "/tmp/project",
			sessionFile: "/tmp/loaded.jsonl",
			name: null,
			modelProvider: "pi",
			cliVersion: "test",
			ephemeral: false,
			projectId: "project-1",
		}).projectId,
		"project-1",
	);
});

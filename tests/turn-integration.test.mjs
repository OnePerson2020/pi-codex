import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { PiHost } from "../src/pi-host.mjs";
import { loadPiSdk } from "../src/pi-sdk.mjs";

test("Pi agent loop calls a Desktop dynamic tool and completes the turn", async (t) => {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-desktop-turn-test-"));
	t.after(() => fs.rm(agentDir, { recursive: true, force: true }));
	const sdk = await loadPiSdk();
	const fauxModule = await import(
		pathToFileURL(
			path.join(
				sdk.packageRoot,
				"node_modules/@earendil-works/pi-ai/dist/providers/faux.js",
			),
		).href
	);
	const faux = fauxModule.fauxProvider({
		provider: "desktop-test",
		models: [
			{
				id: "faux-1",
				name: "Faux",
				reasoning: true,
				input: ["text"],
				contextWindow: 10_000,
				maxTokens: 1_000,
			},
		],
	});
	faux.setResponses([
		fauxModule.fauxAssistantMessage(
			[
				fauxModule.fauxThinking("checking"),
				fauxModule.fauxToolCall("desktop_echo", { text: "ping" }, { id: "desktop-call-1" }),
			],
			{ stopReason: "toolUse" },
		),
		fauxModule.fauxAssistantMessage("desktop said pong"),
	]);

	const cwd = process.cwd();
	const modelRuntime = await sdk.ModelRuntime.create({
		authPath: path.join(agentDir, "auth.json"),
		modelsPath: null,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	const settingsManager = sdk.SettingsManager.inMemory({
		defaultProvider: "desktop-test",
		defaultModel: "faux-1",
		defaultThinkingLevel: "low",
	});
	const services = await sdk.createAgentSessionServices({
		cwd,
		agentDir,
		settingsManager,
		modelRuntime,
		resourceLoaderOptions: {
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		},
	});

	const sent = [];
	let host;
	host = new PiHost({
		sdk,
		cwd,
		agentDir,
		codexHome: agentDir,
		piVersion: sdk.VERSION,
		send: (message) => {
			sent.push(message);
			if (message.method === "item/tool/call") {
				queueMicrotask(() => {
					void host.handle({
						jsonrpc: "2.0",
						id: message.id,
						result: {
							success: true,
							contentItems: [{ type: "inputText", text: "pong" }],
						},
					});
				});
			}
		},
	});
	host.createServices = async () => services;
	t.after(() => host.shutdown());

	const started = await host.startThread({
		cwd,
		ephemeral: true,
		model: "desktop-test/faux-1",
		effort: "low",
		dynamicTools: [
			{
				type: "namespace",
				name: "codex_app",
				tools: [
					{
						type: "function",
						name: "desktop_echo",
						description: "Echo through Desktop",
						inputSchema: {
							type: "object",
							properties: { text: { type: "string" } },
							required: ["text"],
						},
					},
				],
			},
		],
	});
	await host.startTurn({
		threadId: started.thread.id,
		input: [{ type: "text", text: "use the tool" }],
	});
	await waitFor(() => sent.some((message) => message.method === "turn/completed"));

	const methods = sent.map((message) => message.method).filter(Boolean);
	assert.ok(methods.includes("item/tool/call"));
	assert.ok(methods.includes("item/reasoning/textDelta"));
	assert.ok(methods.includes("item/agentMessage/delta"));
	assert.equal(sent.find((message) => message.method === "turn/completed").params.turn.status, "completed");
	assert.equal(faux.state.callCount, 2);
	await host.shutdown();
});

async function waitFor(predicate) {
	const deadline = Date.now() + 3_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for Pi turn");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

import assert from "node:assert/strict";
import { loadPiSdk } from "../src/pi-sdk.mjs";

const sdk = await loadPiSdk();
sdk.outputGuard.takeOverStdout();

const cwd = process.cwd();
const agentDir = sdk.getAgentDir();
const projectTrusted = new sdk.ProjectTrustStore(agentDir).get(cwd) === true;
const settingsManager = sdk.SettingsManager.create(cwd, agentDir, { projectTrusted });
const services = await sdk.createAgentSessionServices({
	cwd,
	agentDir,
	settingsManager,
});
const created = await sdk.createAgentSessionFromServices({
	services,
	sessionManager: sdk.SessionManager.inMemory(cwd),
});

try {
	await created.session.bindExtensions({
		mode: "rpc",
		uiContext: noOpUi(),
	});
	const tools = created.session.getAllTools().map((tool) => tool.name);
	const skills = services.resourceLoader.getSkills().skills;
	const extensions = created.extensionsResult.extensions;

	assert.ok(created.session.model, "Pi must resolve a configured model");
	assert.ok(tools.includes("read"), "Pi built-in read tool must load");
	assert.ok(skills.length > 0, "Pi skills must remain discoverable");
	assert.ok(extensions.length > 0, "Pi extensions must remain discoverable");

	sdk.outputGuard.writeRawStdout(
		`${JSON.stringify({
			ok: true,
			piVersion: sdk.VERSION,
			model: `${created.session.model.provider}/${created.session.model.id}`,
			toolCount: tools.length,
			tools,
			skillCount: skills.length,
			extensionCount: extensions.length,
		})}\n`,
	);
	await sdk.outputGuard.flushRawStdout();
} finally {
	await new sdk.AgentSessionRuntime(
		created.session,
		services,
		async () => {
			throw new Error("not used by smoke test");
		},
	).dispose();
}

function noOpUi() {
	return {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify() {},
		onTerminalInput: () => () => {},
		setStatus() {},
		setWorkingMessage() {},
		setWorkingVisible() {},
		setWorkingIndicator() {},
		setHiddenThinkingLabel() {},
		setWidget() {},
		setFooter() {},
		setHeader() {},
		setTitle() {},
		custom: async () => undefined,
		pasteToEditor() {},
		setEditorText() {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider() {},
		setEditorComponent() {},
		getEditorComponent: () => undefined,
		theme: undefined,
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "unsupported" }),
		getToolsExpanded: () => false,
		setToolsExpanded() {},
	};
}

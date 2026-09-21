import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { desktopMcpFromArgs, writeDesktopMcpConfig } from "../src/desktop-mcp.mjs";

test("Desktop Codex MCP TOML is converted to a Pi MCP direct-tool config", async (t) => {
	const previous = process.env.CODEX_APP_TOOLS_PIPE_PATH;
	process.env.CODEX_APP_TOOLS_PIPE_PATH = "/tmp/codex-app.sock";
	try {
		const definition = await desktopMcpFromArgs(
			[
				"-c",
				'mcp_servers.codex_app={"command"="/tmp/launch","args"=["./server.mjs"],"cwd"="/tmp/plugin","enabled"=true,"tools"={"create_thread"={"approval_mode"="prompt"},"list_threads"={"approval_mode"="approve"}},"env_vars"=["CODEX_APP_TOOLS_PIPE_PATH"],"tool_timeout_sec"=3600}',
			],
			path.join(os.homedir(), ".pi/agent"),
		);
		assert.equal(definition.command, "/tmp/launch");
		assert.deepEqual(definition.args, ["./server.mjs"]);
		assert.deepEqual(definition.approveTools, ["create_thread"]);
		assert.equal(definition.env.CODEX_APP_TOOLS_PIPE_PATH, "/tmp/codex-app.sock");
		assert.equal(definition.requestTimeoutMs, 3_600_000);

		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-app-pi-mcp-"));
		t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
		const configPath = path.join(directory, "desktop-mcp.json");
		writeDesktopMcpConfig(definition, configPath);
		const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
		assert.equal(config.mcpServers.codex_app.directTools, true);
		assert.equal(config.mcpServers.codex_app.toolPrefix, "none");
		assert.deepEqual(config.mcpServers.codex_app.approveTools, ["create_thread"]);
	} finally {
		if (previous === undefined) delete process.env.CODEX_APP_TOOLS_PIPE_PATH;
		else process.env.CODEX_APP_TOOLS_PIPE_PATH = previous;
	}
});

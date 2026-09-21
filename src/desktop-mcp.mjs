import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CONFIG_KEY = "mcp_servers.codex_app=";
const REGISTER_EVENT = "pi-mcp-adapter:runtime-register:v1";

export async function desktopMcpFromArgs(argv, agentDir) {
	const raw = findConfigValue(argv);
	if (!raw) return null;
	const parseToml = await loadTomlParser(agentDir);
	const value = parseToml(`value = ${raw}`).value;
	if (!value || typeof value !== "object" || value.enabled === false) return null;
	if (typeof value.command !== "string" || !value.command) return null;

	const env = {};
	for (const name of Array.isArray(value.env_vars) ? value.env_vars : []) {
		if (typeof name === "string" && process.env[name] !== undefined) {
			env[name] = process.env[name];
		}
	}
	const approveTools = Object.entries(value.tools || {})
		.filter(([, settings]) => settings?.approval_mode === "prompt")
		.map(([name]) => name);

	return {
		command: value.command,
		args: Array.isArray(value.args) ? value.args.filter((item) => typeof item === "string") : [],
		cwd: typeof value.cwd === "string" ? value.cwd : undefined,
		env,
		literalEnv: true,
		lifecycle: "keep-alive",
		requestTimeoutMs:
			Number.isFinite(value.tool_timeout_sec) && value.tool_timeout_sec > 0
				? value.tool_timeout_sec * 1000
				: undefined,
		approveTools: approveTools.length ? approveTools : false,
	};
}

export function writeDesktopMcpConfig(definition, configPath) {
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	const payload = {
		mcpServers: {
			codex_app: {
				...definition,
				directTools: true,
				toolPrefix: "none",
			},
		},
		settings: {
			footerStatus: "off",
		},
	};
	fs.writeFileSync(configPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

export function desktopMcpExtension(definition) {
	return {
		name: "codex-app-mcp",
		hidden: true,
		factory(pi) {
			let registration;
			pi.on("session_start", (_event, ctx) => {
				if (registration) return;
				const request = {
					version: 1,
					name: "codex_app",
					definition,
				};
				pi.events.emit(REGISTER_EVENT, request);
				if (!request.result) {
					ctx.ui.notify(
						"Desktop tools require the installed pi-mcp-adapter package.",
						"warning",
					);
					return;
				}
				if (!request.result.ok) {
					if (!String(request.result.error?.message).includes("already registered")) {
						ctx.ui.notify(
							`Desktop tools could not be registered: ${request.result.error}`,
							"warning",
						);
					}
					return;
				}
				registration = request.result.registration;
			});
			pi.on("session_shutdown", async () => {
				const current = registration;
				registration = undefined;
				await current?.dispose();
			});
		},
	};
}

function findConfigValue(argv) {
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if ((arg === "-c" || arg === "--config") && typeof argv[index + 1] === "string") {
			const value = argv[index + 1];
			if (value.startsWith(CONFIG_KEY)) return value.slice(CONFIG_KEY.length);
			index += 1;
			continue;
		}
		if (typeof arg === "string" && arg.startsWith(`--config=${CONFIG_KEY}`)) {
			return arg.slice(`--config=${CONFIG_KEY}`.length);
		}
	}
	return null;
}

async function loadTomlParser(agentDir) {
	const candidates = [
		path.join(agentDir, "npm/node_modules/smol-toml/dist/index.js"),
		path.join(agentDir, "npm/node_modules/pi-mcp-adapter/node_modules/smol-toml/dist/index.js"),
	];
	for (const candidate of candidates) {
		if (!fs.existsSync(candidate)) continue;
		const module = await import(pathToFileURL(candidate).href);
		if (typeof module.parse === "function") return module.parse;
	}
	throw new Error("Cannot parse Desktop MCP config: pi-mcp-adapter's smol-toml dependency was not found");
}

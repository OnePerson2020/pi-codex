#!/usr/bin/env node

import { desktopSshTarget, relaySsh, requireRemoteSdkVersion } from "./src/ssh-transport.mjs";
import { loadPiSdk } from "./src/pi-sdk.mjs";
import { PiHost } from "./src/pi-host.mjs";
import { PiWebStatus } from "./src/pi-web-status.mjs";
import { splitStrictJsonLines } from "./src/protocol.mjs";
import { desktopMcpExtension, desktopMcpFromArgs } from "./src/desktop-mcp.mjs";
import fs from "node:fs";
import path from "node:path";
import { attachPersistentHost, hostSocketPath, servePersistentHost } from "./src/persistent-host.mjs";

// Route before loading any local Pi services or reading local credentials.
const sshTarget = desktopSshTarget();
if (sshTarget) {
	try { await relaySsh(sshTarget); process.exit(0); }
	catch (error) { console.error(error.message); process.exit(1); }
}

if (process.argv.includes("--attach")) {
	try { await attachPersistentHost(hostSocketPath()); process.exit(0); }
	catch (error) { console.error(`pi-codex persistent host: ${error.message}`); process.exit(1); }
}
const serving = process.argv.includes("--serve");
const sdk = await loadPiSdk();
requireRemoteSdkVersion(sdk, sdk.VERSION);
sdk.outputGuard.takeOverStdout();
const agentDir = sdk.getAgentDir();
const desktopMcp = serving ? null : await desktopMcpFromArgs(process.argv.slice(2), agentDir);

const send = (message) => {
	sdk.outputGuard.writeRawStdout(`${JSON.stringify(message)}\n`);
};

const host = new PiHost({
	sdk,
	send,
	cwd: process.cwd(),
	agentDir,
	piVersion: sdk.VERSION,
	piWebStatus: new PiWebStatus({ url: process.env.PI_DESKTOP_PI_WEB_URL,
		password: process.env.PI_DESKTOP_PI_WEB_PASSWORD }),
	inlineExtensions: desktopMcp ? [desktopMcpExtension(desktopMcp)] : [],
});

if (serving) {
	try {
		const owner = await servePersistentHost(host, hostSocketPath());
		for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => {
			const deadline = setTimeout(() => process.exit(1), 5000);
			void owner.close().then(() => { clearTimeout(deadline); process.exit(0); }).catch(() => process.exit(1));
		});
	} catch (error) { console.error(error); process.exit(1); }
} else {
const diagnosticPath = process.env.PI_DESKTOP_RPC_LOG
	? path.resolve(process.env.PI_DESKTOP_RPC_LOG)
	: null;
if (diagnosticPath) fs.mkdirSync(path.dirname(diagnosticPath), { recursive: true });

function logMethod(direction, message) {
	if (!diagnosticPath) return;
	const method =
		typeof message?.method === "string"
			? message.method
			: Object.hasOwn(message || {}, "id")
				? "response"
				: "unknown";
	const routing = message?.method === "thread/list" && Object.hasOwn(message.params ?? {}, "projectId")
		? ` projectId=${JSON.stringify(message.params.projectId)}` : "";
	fs.appendFileSync(
		diagnosticPath,
		`${new Date().toISOString()} ${direction} ${method} id=${String(message?.id ?? "-")}${routing}\n`,
	);
}

let requestTail = Promise.resolve();
const onLine = splitStrictJsonLines((line) => {
	let message;
	try {
		message = JSON.parse(line);
	} catch (error) {
		send({
			jsonrpc: "2.0",
			id: null,
			error: {
				code: -32700,
				message: error instanceof Error ? error.message : String(error),
			},
		});
		return;
	}

	logMethod("app->pi", message);
	if (host.closing) return;
	if ((!message.method && Object.hasOwn(message, "id")) || message.method === "turn/interrupt") {
		void host.handle(message);
		return;
	}
	requestTail = requestTail
		.then(() => host.handle(message))
		.catch((error) => {
			console.error(error instanceof Error ? error.stack : String(error));
		});
});

process.stdin.setEncoding("utf8");
process.stdin.on("data", onLine);
let stopping;
function shutdown(exitCode = 0, drainRequests = false) {
	if (stopping) return stopping;
	// A stuck extension must not leave a detached app-server alive indefinitely.
	const deadline = setTimeout(() => process.exit(1), 5000);
	stopping = (async () => {
		if (drainRequests) {
			host.disconnected = true;
			host.cancelRequests();
			await requestTail;
		}
		await host.shutdown();
		await requestTail;
		await host.shutdown();
		await sdk.outputGuard.flushRawStdout();
		clearTimeout(deadline);
		process.exit(exitCode);
	})().catch((error) => {
		console.error(error);
		process.exit(1);
	});
	return stopping;
}
process.stdin.on("end", () => { void shutdown(0, true); });

for (const signal of process.platform === "win32" ? ["SIGTERM", "SIGINT"] : ["SIGTERM", "SIGINT", "SIGHUP"]) {
	process.on(signal, () => { void shutdown(signal === "SIGHUP" ? 129 : signal === "SIGINT" ? 130 : 143); });
}
}

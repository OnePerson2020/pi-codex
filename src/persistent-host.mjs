import net from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { isImmediateMethod } from "./process-host.mjs";

const MAX_FRAME = 16 * 1024 * 1024;
const MAX_QUEUE = 32 * 1024 * 1024;

export function hostSocketPath(env = process.env) {
	return env.PI_DESKTOP_SOCKET || path.join(env.CODEX_HOME || path.join(env.HOME, ".pi/codex-app"), "host.sock");
}

// One connected controller per host. Many sessions can run in that controller;
// disconnect releases transport ownership, not AgentSession ownership.
export async function servePersistentHost(host, socketPath) {
	await fs.mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
	const directory = await fs.lstat(path.dirname(socketPath));
	if (!directory.isDirectory() || directory.uid !== process.getuid() || (directory.mode & 0o077)) {
		throw new Error("pi-codex socket directory must be owned by this user and mode 0700");
	}
	let controller;
	let tail = Promise.resolve();
	let queuedBytes = 0;
	let pendingCount = 0;
	const responses = new Map();
	host.clientDetached = true;
	const write = (socket, message) => {
		if (!socket || socket.destroyed) return;
		const line = JSON.stringify(message) + "\n";
		if (Buffer.byteLength(line) > MAX_FRAME || socket.writableLength + Buffer.byteLength(line) > MAX_QUEUE) {
			socket.destroy(new Error("pi-codex output overflow; reconnect and reload history"));
			return;
		}
		socket.write(line);
	};
	host.send = (message) => {
		if (!message.method && Object.hasOwn(message, "id")) {
			const route = responses.get(message.id);
			responses.delete(message.id);
			if (route) write(route.socket, { ...message, id: route.id });
		} else write(controller, message);
	};
	const server = net.createServer({ allowHalfOpen: true }, (socket) => {
		socket.on("error", () => {});
		if (controller) {
			socket.end(JSON.stringify({ jsonrpc: "2.0", method: "error", params: { error: {
				message: "pi-codex is in use by another connected client on this host. Disconnect that client first.",
			} } }) + "\n");
			return;
		}
		controller = socket;
		host.clientDetached = false;
		const prefix = crypto.randomUUID();
		let sequence = 0;
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => {
			buffer += chunk;
			if (Buffer.byteLength(buffer) > MAX_QUEUE) return socket.destroy(new Error("Input overflow"));
			for (let end; (end = buffer.indexOf("\n")) >= 0;) {
				const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
				const bytes = Buffer.byteLength(line);
				if (bytes > MAX_FRAME) return socket.destroy(new Error("Frame overflow"));
				let message;
				try {
					message = JSON.parse(line);
					if (!message || Array.isArray(message) || typeof message !== "object") throw new Error("Invalid JSON-RPC message");
				} catch (error) { write(socket, { jsonrpc: "2.0", id: null, error: { code: -32700, message: error.message } }); continue; }
				if (!message.method && Object.hasOwn(message, "id")) { void host.handle(message); continue; }
				if (queuedBytes + bytes > MAX_QUEUE || pendingCount >= 256) return socket.destroy(new Error("Request queue overflow"));
				if (Object.hasOwn(message, "id")) {
					const id = `${prefix}:${++sequence}`;
					responses.set(id, { socket, id: message.id }); message.id = id;
				}
				const run = () => host.handle(message);
				if (isImmediateMethod(message.method)) { void run(); continue; }
				queuedBytes += bytes; pendingCount++;
				tail = tail.then(run).catch((error) => console.error(error)).finally(() => { queuedBytes -= bytes; pendingCount--; });
			}
		});
		const detach = () => {
			if (controller !== socket) return;
			controller = null; host.clientDetached = true;
			// Never transfer consent or replay tool side effects to a new UI process.
			host.cancelRequests();
		};
		socket.once("end", () => { detach(); void tail.finally(() => socket.end()); });
		socket.once("close", () => {
			detach();
			for (const [id, route] of responses) if (route.socket === socket) responses.delete(id);
		});
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});
	await fs.chmod(socketPath, 0o600);
	return {
		server,
		async close() {
			controller?.destroy();
			await host.shutdown();
			await tail;
			await new Promise((resolve) => server.close(resolve));
		},
	};
}

export async function attachPersistentHost(socketPath, { input = process.stdin, output = process.stdout } = {}) {
	const socket = net.createConnection(socketPath);
	await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
	return new Promise((resolve, reject) => {
		const fail = (error) => { socket.destroy(); reject(error); };
		socket.on("error", fail);
		input.on("error", fail); output.on("error", fail);
		input.pipe(socket); socket.pipe(output, { end: false });
		socket.once("close", () => {
			input.unpipe(socket); socket.unpipe(output);
			input.removeListener("error", fail); output.removeListener("error", fail);
			resolve();
		});
	});
}

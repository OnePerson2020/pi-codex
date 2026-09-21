import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";
import { servePersistentHost } from "../src/persistent-host.mjs";

async function client(socketPath) {
	const socket = net.createConnection(socketPath);
	const messages = [];
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("data", chunk => { buffer += chunk; for (let end; (end = buffer.indexOf("\n")) >= 0;) {
		messages.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1);
	} });
	await once(socket, "connect");
	return { socket, messages, send: message => socket.write(JSON.stringify(message) + "\n") };
}
async function until(predicate) {
	const end = Date.now() + 2000;
	while (!predicate()) { if (Date.now() > end) throw new Error("Timed out"); await new Promise(r => setTimeout(r, 5)); }
}

test("owner survives disconnect, rejects another controller, and never cross-routes delayed replies", async t => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-owner-"));
	const socketPath = path.join(dir, "host.sock");
	const host = { dynamicCalls: new Map(), shutdowns: 0, completed: 0,
		async handle(message) {
			if (message.method === "run") { await new Promise(r => setTimeout(r, 100)); this.completed++; }
			this.send({ id: message.id, result: { completed: this.completed } });
		}, async shutdown() { this.shutdowns++; }, cancelRequests() {},
	};
	const owner = await servePersistentHost(host, socketPath);
	t.after(async () => { await owner.close(); await fs.rm(dir, { recursive: true, force: true }); });
	const a = await client(socketPath);
	const occupied = await client(socketPath);
	await until(() => occupied.messages.length);
	assert.match(occupied.messages[0].params.error.message, /in use/);
	a.send({ id: 1, method: "run" });
	await new Promise(r => setTimeout(r, 20));
	a.socket.destroy();
	await until(() => host.clientDetached);
	const b = await client(socketPath);
	b.send({ id: 1, method: "status" });
	await until(() => b.messages.length);
	assert.equal(host.completed, 1);
	assert.equal(host.shutdowns, 0);
	assert.equal(b.messages.length, 1);
	assert.deepEqual(b.messages[0], { id: 1, result: { completed: 1 } });
	b.socket.destroy();
	assert.equal((await fs.stat(socketPath)).mode & 0o777, 0o600);
});

test("unsafe socket directory is refused without changing its permissions", async t => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-owner-unsafe-"));
	t.after(() => fs.rm(dir, { recursive: true, force: true }));
	await fs.chmod(dir, 0o755);
	await assert.rejects(servePersistentHost({}, path.join(dir, "host.sock")), /0700/);
	assert.equal((await fs.stat(dir)).mode & 0o777, 0o755);
});

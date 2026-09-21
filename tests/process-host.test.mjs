import assert from "node:assert/strict";
import test from "node:test";
import { ProcessHost } from "../src/process-host.mjs";

function collector() {
	const deltas = [];
	const exited = [];
	const host = new ProcessHost({
		send: (message) => {
			if (message.method === "process/outputDelta") deltas.push(message.params);
			if (message.method === "process/exited") exited.push(message.params);
		},
	});
	return { host, deltas, exited, text: () => Buffer.concat(deltas.map((d) => Buffer.from(d.deltaBase64, "base64"))).toString() };
}

async function waitFor(predicate, label, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`Timed out waiting for ${label}`);
}

test("pty session reports size, streams output, resizes, and exits", async () => {
	const { host, exited, text } = collector();
	const { processHandle } = await host.spawn({
		command: ["sh", "-c", "stty size; read x; stty size"],
		cwd: "/tmp",
		tty: true,
		size: { cols: 100, rows: 30 },
	});
	assert.ok(processHandle);
	await waitFor(() => text().includes("30 100"), "initial pty size");
	host.resizePty({ processHandle, size: { cols: 120, rows: 40 } });
	await new Promise((resolve) => setTimeout(resolve, 200));
	host.writeStdin({ processHandle, deltaBase64: Buffer.from("go\n").toString("base64") });
	await waitFor(() => text().includes("40 120"), "resized pty size");
	await waitFor(() => exited.length === 1, "exit notification");
	assert.equal(exited[0].processHandle, processHandle);
	assert.equal(exited[0].exitCode, 0);
});

test("kill terminates a running session once", async () => {
	const { host, exited } = collector();
	const { processHandle } = await host.spawn({ command: ["sleep", "30"], cwd: "/tmp", tty: true });
	host.kill({ processHandle });
	await waitFor(() => exited.length === 1, "exit notification");
	assert.equal(host.sessions.size, 0);
});

test("closing the terminal hangs up the session", async () => {
	const { host, exited } = collector();
	const { processHandle } = await host.spawn({ command: ["sleep", "30"], cwd: "/tmp", tty: true });
	host.writeStdin({ processHandle, closeStdin: true });
	await waitFor(() => exited.length === 1, "exit notification");
	assert.equal(host.sessions.size, 0);
});

test("spawn failures and unknown handles are rejects", async () => {
	const { host } = collector();
	await assert.rejects(() => host.spawn({ command: ["./pi-codex-missing-binary"], cwd: "/tmp", tty: false }), /Could not start/);
	assert.throws(() => host.writeStdin({ processHandle: "process:nope" }), /Unknown process handle/);
	assert.throws(() => host.resizePty({ processHandle: "process:nope" }), /Unknown process handle/);
	await assert.rejects(() => host.spawn({ command: [], cwd: "/tmp" }), /non-empty command/);
});

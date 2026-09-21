import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PiWebStatus, piWebLabel } from "../src/pi-web-status.mjs";

async function fixture(t) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-web-status-"));
	const file = path.join(directory, "session.jsonl");
	await fs.writeFile(file, "fixture");
	const state = { data: { sessions: [{ id: "s", path: file }], runningSessionIds: [] }, requests: [] };
	const server = http.createServer((req, res) => {
		state.requests.push({ url: req.url, auth: req.headers.authorization });
		if (state.hang) return;
		res.writeHead(state.code || 200, state.headers || { "Content-Type": "application/json" });
		res.end(JSON.stringify(state.data));
	});
	await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
	const client = new PiWebStatus({ url: `http://127.0.0.1:${server.address().port}`, password: "test-only", timeoutMs: 200 });
	t.after(async () => { client.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
	return { directory, file, state, client };
}

test("Web status uses exact id and canonical file, caches reads but refreshes admission", async t => {
	const { directory, file, state, client } = await fixture(t);
	await client.refresh();
	assert.equal(client.status("s", file), "notRunning");
	state.data.runningSessionIds = ["s"];
	await client.refresh();
	assert.equal(state.requests.length, 1);
	assert.equal(client.status("s", file), "notRunning");
	await client.refresh({ force: true });
	assert.equal(client.status("s", file), "running");
	client.checkedAt -= 6000;
	assert.equal(client.status("s", file), "unknown", "suspended poller cannot attest old state");
	await client.refresh({ force: true });
	assert.equal(state.requests[0].url, "/api/sessions");
	assert.equal(state.requests[0].auth, `Basic ${Buffer.from("pi:test-only").toString("base64")}`);
	const alias = path.join(directory, "alias.jsonl");
	await fs.symlink(file, alias);
	assert.equal(client.status("s", alias), "running");
	assert.equal(client.status("other", file), "unknown");
	const different = path.join(directory, "different.jsonl");
	await fs.writeFile(different, "same id but different file");
	assert.equal(client.status("s", different), "unknown");
	state.data.sessions.push({ id: "s", path: file });
	await client.refresh({ force: true });
	assert.equal(client.status("s", file), "unknown");
});

test("auth, schema, redirect and timeout failures discard stale idle/running evidence", async t => {
	const { file, state, client } = await fixture(t);
	for (const failure of [401, 500, 302, "malformed", "timeout"]) {
		Object.assign(state, { code: 200, hang: false, headers: undefined,
			data: { sessions: [{ id: "s", path: file }], runningSessionIds: ["s"] } });
		await client.refresh({ force: true });
		assert.equal(client.status("s", file), "running");
		if (typeof failure === "number") state.code = failure;
		if (failure === 302) state.headers = { Location: "/login" };
		if (failure === "malformed") state.data = { sessions: [] };
		if (failure === "timeout") state.hang = true;
		const start = Date.now();
		await client.refresh({ force: true });
		assert.equal(client.status("s", file), "unknown", String(failure));
		assert.ok(Date.now() - start < 2000, "bounded status request");
	}
	assert.ok(state.requests.every(req => req.url === "/api/sessions"), "never follow login redirects");
});

test("loopback-only endpoint and display labels do not mutate canonical names", () => {
	for (const url of ["https://example.com", "file:///tmp/x", "http://user:secret@localhost", "http://localhost/base", "http://localhost/?secret=x"]) {
		assert.throws(() => new PiWebStatus({ url }), /loopback/);
	}
	assert.equal(piWebLabel("Original", "prompt", "running"), "Original [Pi Web 运行中]");
	assert.equal(piWebLabel(null, "prompt", "unknown"), null);
	assert.equal(piWebLabel(null, "prompt", "notRunning"), null);
});

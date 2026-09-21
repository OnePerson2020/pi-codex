import fs from "node:fs";
import path from "node:path";

// Pi Web 0.9.1: GET /api/sessions lists all known files; runningSessionIds
// uses isRunning(), NOT the per-session route's runtime-alive `running` flag.
// This is an observation of one Web instance, never a cross-client lease.
export class PiWebStatus {
	constructor({ url = "http://127.0.0.1:30141", password, timeoutMs = 1500, cacheMs = 1000 } = {}) {
		this.url = new URL(url);
		if (!["http:", "https:"].includes(this.url.protocol) ||
			!["127.0.0.1", "localhost", "[::1]"].includes(this.url.hostname) ||
			this.url.username || this.url.password || this.url.pathname !== "/" || this.url.search || this.url.hash) {
			throw new Error("PI_DESKTOP_PI_WEB_URL must be a same-host loopback HTTP(S) origin");
		}
		this.headers = password ? { Authorization: `Basic ${Buffer.from(`pi:${password}`).toString("base64")}` } : {};
		this.timeoutMs = timeoutMs;
		this.cacheMs = cacheMs;
		this.snapshot = null;
		this.checkedAt = 0;
		this.pending = null;
		this.closed = false;
	}

	async refresh({ force = false } = {}) {
		if (this.closed) return;
		while (this.pending) {
			await this.pending;
			if (!force || this.closed) return;
		}
		if (!force && Date.now() - this.checkedAt < this.cacheMs) return;
		const pending = this.fetchSnapshot();
		this.pending = pending;
		try { await pending; }
		finally { if (this.pending === pending) this.pending = null; }
	}

	async fetchSnapshot() {
		const controller = new AbortController();
		this.controller = controller;
		const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			const response = await fetch(new URL("/api/sessions", this.url), {
				headers: this.headers, signal: controller.signal, redirect: "error",
			});
			if (!response.ok) throw new Error("Pi Web status request failed");
			const chunks = [];
			let size = 0;
			for await (const chunk of response.body) {
				size += chunk.length;
				if (size > 8 * 1024 * 1024) throw new Error("Pi Web status response exceeds 8 MiB");
				chunks.push(chunk);
			}
			const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			if (!Array.isArray(data.sessions) || !Array.isArray(data.runningSessionIds) ||
				!data.runningSessionIds.every(id => typeof id === "string" && id)) throw new Error("Invalid Pi Web status response");
			const files = new Map();
			for (const row of data.sessions) {
				if (!row || typeof row.id !== "string" || !row.id || typeof row.path !== "string") throw new Error("Invalid Pi Web session identity");
				// Ambiguous IDs and ephemeral sessions cannot attest ownership of a file.
				files.set(row.id, files.has(row.id) ? null : row.path);
			}
			// Do not retain prompts, names, credentials, or other session list content.
			if (!this.closed) this.snapshot = { files, running: new Set(data.runningSessionIds) };
		} catch {
			// Never reuse stale idle/running evidence after disconnect, auth failure,
			// incompatible responses, or timeout. Do not expose server response bodies.
			this.snapshot = null;
		} finally {
			clearTimeout(timeout);
			if (this.controller === controller) this.controller = null;
			this.checkedAt = Date.now();
		}
	}

	status(id, file) {
		if (!file) return "notRunning";
		if (this.closed || Date.now() - this.checkedAt > 5000) return "unknown";
		const reported = this.snapshot?.files.get(id);
		if (!reported || !path.isAbsolute(reported)) return "unknown";
		try {
			if (fs.realpathSync(reported) !== fs.realpathSync(file)) return "unknown";
		} catch { return "unknown"; }
		return this.snapshot.running.has(id) ? "running" : "notRunning";
	}

	close() {
		this.closed = true;
		this.controller?.abort();
		this.snapshot = null;
	}
}

export function piWebLabel(name, preview, status) {
	return status === "running" ? `${name || preview || "未命名会话"} [Pi Web 运行中]` : name;
}

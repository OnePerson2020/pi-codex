import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function fingerprint(file) {
	try {
		const s = fs.statSync(file, { bigint: true });
		return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
	} catch (error) { if (error.code === "ENOENT") return "missing"; throw error; }
}

function sessionLock(file) {
	return `${path.join(fs.realpathSync(path.dirname(file)), path.basename(file))}.desktop-lock`;
}

function writerConflict(lock) {
	let owner = "unknown owner";
	try { owner = fs.readFileSync(lock, "utf8").trim(); } catch {}
	return new Error(`Session already has an active writer or an unresolved writer lease; it is in use by another pi-codex writer (${owner}). View history only. Close that session first. After a crash, verify the owner has exited before removing ${lock}`);
}

// Advisory UI probe only. Actual admission still uses atomic exclusive creation.
export function assertSessionAvailable(file) {
	if (!file) return;
	try { fs.lstatSync(sessionLock(file)); }
	catch (error) { if (error.code === "ENOENT") return; throw error; }
	throw writerConflict(sessionLock(file));
}

// Advisory for Desktop writers. Unmodified CLI/Web do not honor this lease;
// detect their writes and fail closed rather than pretending they are locked out.
export function acquireSessionGuard(file, warn = () => {}) {
	if (!file) return { bind() {}, check() {}, release() {} };
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const canonical = path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
	const lock = `${canonical}.desktop-lock`;
	let fd;
	try { fd = fs.openSync(lock, "wx", 0o600); }
	catch (error) {
		if (error.code !== "EEXIST") throw error;
		throw writerConflict(lock);
	}
	fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), client: "pi-codex" }));
	fs.closeSync(fd);
	let expected = fingerprint(canonical);
	let conflict;
	let timer;
	const restore = [];
	const check = () => {
		if (!conflict && fingerprint(canonical) !== expected) {
			conflict = new Error("This session was changed by another client (CLI / Pi Web / Desktop). Desktop has stopped writing; close it and reopen after the other client finishes.");
			warn(conflict.message);
		}
		if (conflict) throw conflict;
	};
	return {
		check,
		bind(manager) {
			// SDK 0.85.1 seam: cover all append and rewrite callers, including extensions.
			for (const key of ["_appendEntry", "_rewriteFile"]) {
				if (typeof manager[key] !== "function") throw new Error(`Pi SDK lacks guarded session seam: ${key}`);
				const original = manager[key];
				const wrapped = function (...args) {
					check();
					const result = original.apply(this, args);
					expected = fingerprint(canonical);
					return result;
				};
				manager[key] = wrapped;
				restore.push(() => { if (manager[key] === wrapped) manager[key] = original; });
			}
			timer = setInterval(() => { try { check(); } catch {} }, 1000);
			timer.unref();
		},
		release() {
			clearInterval(timer);
			for (const unbind of restore) unbind();
			fs.unlinkSync(lock);
		},
	};
}

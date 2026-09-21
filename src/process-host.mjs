import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";

const MAX_SESSIONS = 32;
const DEFAULT_SIZE = { cols: 80, rows: 24 };

// The bridge is plain JavaScript (no node-pty), so python3 owns the pty and fd 3
// is a control pipe for resize/hangup. Without python3 the process still runs,
// but it is a pipe, not a terminal.
const PTY_RELAY = `
import fcntl, os, pty, select, signal, struct, sys, termios

cols, rows, command = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3:]

def resize(fd):
	fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

def group(sig):
	try:
		os.killpg(pid, sig)
	except OSError:
		pass

pid, master = pty.fork()
if pid == 0:
	resize(0)
	os.execvp(command[0], command)
	os._exit(127)

resize(master)
group(signal.SIGWINCH)

def hangup(signum=None, _frame=None):
	group(signal.SIGHUP)
	os._exit(128 + signum if signum is not None else 0)

for name in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
	signal.signal(name, hangup)

control, pending, live = 3, "", True
while True:
	watched = [0]
	if control is not None:
		watched.append(control)
	if live:
		watched.append(master)
	ready = select.select(watched, [], [])[0]
	if live and master in ready:
		try:
			chunk = os.read(master, 65536)
		except OSError:
			chunk = b""
		if chunk:
			os.write(1, chunk)
		else:
			try:
				os.close(master)
			except OSError:
				pass
			live = False
	if 0 in ready:
		chunk = os.read(0, 65536)
		# Our stdin closes when the owning bridge goes away.
		if not chunk:
			hangup()
		os.write(master, chunk)
	if control is not None and control in ready:
		chunk = os.read(control, 65536)
		if not chunk:
			control = None
		else:
			pending += chunk.decode("utf8", "replace")
			while "\\n" in pending:
				line, _, pending = pending.partition("\\n")
				parts = line.split()
				if parts[:1] == ["resize"] and len(parts) == 3 and live:
					cols, rows = int(parts[1]), int(parts[2])
					resize(master)
					group(signal.SIGWINCH)
				elif parts[:1] == ["hangup"]:
					hangup()
	if not live:
		break

status = os.waitpid(pid, os.WNOHANG)[1]
os._exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 0)
`;

let relayAvailable = null;
function ptyRelayAvailable() {
	if (relayAvailable === null) {
		const probe = spawnSync("python3", ["-c", "import pty"], { stdio: "ignore" });
		relayAvailable = !probe.error && probe.status === 0;
	}
	return relayAvailable;
}

function spawnEnv(env) {
	const result = { ...process.env };
	if (!env || typeof env !== "object") return result;
	for (const [name, value] of Object.entries(env)) {
		if (value === null || value === undefined) delete result[name];
		else if (typeof value !== "object") result[name] = String(value);
	}
	return result;
}

function resolveCwd(cwd) {
	if (typeof cwd !== "string" || !cwd) return os.homedir();
	const resolved = cwd.startsWith("~/") ? `${os.homedir()}/${cwd.slice(2)}` : cwd;
	try {
		return fs.statSync(resolved).isDirectory() ? resolved : os.homedir();
	} catch {
		return os.homedir();
	}
}

function normalizeSize(size) {
	const cols = Number.isInteger(size?.cols) && size.cols > 0 ? size.cols : DEFAULT_SIZE.cols;
	const rows = Number.isInteger(size?.rows) && size.rows > 0 ? size.rows : DEFAULT_SIZE.rows;
	return { cols, rows };
}

// Interactive terminal traffic must not queue behind long requests in the
// app-server read loop (see pi-app-server.mjs and persistent-host.mjs).
export function isImmediateMethod(method) {
	return method === "turn/interrupt" || method === "process/writeStdin" ||
		method === "process/resizePty" || method === "process/kill";
}

export class ProcessHost {
	constructor({ send }) {
		this.send = send;
		this.sessions = new Map();
	}

	notification(method, params) {
		this.send({ jsonrpc: "2.0", method, params });
	}

	async spawn(params) {
		const handle = typeof params.processHandle === "string" && params.processHandle
			? params.processHandle
			: `process:${randomUUID()}`;
		if (this.sessions.has(handle)) throw new Error(`Process handle is already in use: ${handle}`);
		if (this.sessions.size >= MAX_SESSIONS) throw new Error("pi-codex process limit reached; kill an open terminal first");
		const command = (Array.isArray(params.command) ? params.command : []).filter((part) => typeof part === "string");
		if (!command.length || !command[0]) throw new Error("process/spawn requires a non-empty command array");

		const tty = params.tty === true && ptyRelayAvailable();
		const cwd = resolveCwd(params.cwd);
		const env = spawnEnv(params.env);
		const size = normalizeSize(params.size);
		const child = tty
			? spawn("python3", ["-c", PTY_RELAY, String(size.cols), String(size.rows), ...command], {
				cwd, env, stdio: ["pipe", "pipe", "pipe", "pipe"],
			})
			: spawn(command[0], command.slice(1), { cwd, env, stdio: ["pipe", "pipe", "pipe"] });

		const session = {
			child,
			tty,
			capBytes: Number.isFinite(params.outputBytesCap) && params.outputBytesCap > 0 ? params.outputBytesCap : null,
			sentBytes: 0,
			capReached: false,
			closed: false,
			timer: null,
		};
		this.sessions.set(handle, session);
		if (Number.isFinite(params.timeoutMs) && params.timeoutMs > 0) {
			session.timer = setTimeout(() => { child.kill("SIGTERM"); }, params.timeoutMs);
			session.timer.unref?.();
		}

		const forward = (stream) => (chunk) => {
			let bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			if (session.capReached) return;
			if (session.capBytes !== null && session.sentBytes + bytes.length >= session.capBytes) {
				bytes = bytes.subarray(0, session.capBytes - session.sentBytes);
				session.capReached = true;
			}
			session.sentBytes += bytes.length;
			if (!bytes.length) return;
			this.notification("process/outputDelta", {
				processHandle: handle,
				deltaBase64: bytes.toString("base64"),
				stream,
				capReached: session.capReached,
			});
		};
		child.stdout.on("data", forward("stdout"));
		child.stderr?.on("data", forward("stderr"));
		child.on("exit", (code, signal) => {
			if (session.closed) return;
			session.closed = true;
			clearTimeout(session.timer);
			this.sessions.delete(handle);
			this.notification("process/exited", {
				processHandle: handle,
				exitCode: code ?? (signal ? 1 : 0),
				stdout: "",
				stderr: "",
			});
		});
		try {
			await new Promise((resolve, reject) => {
				child.once("spawn", resolve);
				child.once("error", reject);
			});
		} catch (error) {
			session.closed = true;
			clearTimeout(session.timer);
			this.sessions.delete(handle);
			throw new Error(`Could not start ${command[0]}: ${error.code || error.message}`);
		}
		return { processHandle: handle };
	}

	writeStdin(params) {
		const session = this.sessions.get(params.processHandle);
		if (!session) throw new Error("Unknown process handle");
		if (typeof params.deltaBase64 === "string" && params.deltaBase64) {
			session.child.stdin.write(Buffer.from(params.deltaBase64, "base64"));
		}
		if (params.closeStdin === true) {
			if (session.tty) session.child.stdio[3].write("hangup\n");
			else session.child.stdin.end();
		}
		return {};
	}

	resizePty(params) {
		const session = this.sessions.get(params.processHandle);
		if (!session) throw new Error("Unknown process handle");
		if (!session.tty) return {};
		const { cols, rows } = normalizeSize(params.size);
		session.child.stdio[3].write(`resize ${cols} ${rows}\n`);
		return {};
	}

	kill(params) {
		const session = this.sessions.get(params.processHandle);
		if (!session) return {};
		session.child.kill("SIGTERM");
		const timer = setTimeout(() => session.child.kill("SIGKILL"), 2000);
		timer.unref?.();
		return {};
	}

	disposeAll() {
		for (const session of this.sessions.values()) {
			session.child.kill("SIGKILL");
		}
		this.sessions.clear();
	}
}

import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const quote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;

export function desktopSshTarget(env = process.env) {
	if (env.PI_DESKTOP_ENABLE_SSH !== "1") {
		if (env.PI_DESKTOP_HOST_KIND === "ssh" || env.PI_DESKTOP_SSH_TARGET_JSON) {
			throw new Error("SSH routing is disabled; refusing to run the remote host locally");
		}
		return null;
	}
	if (env.PI_DESKTOP_HOST_KIND === "local" && !env.PI_DESKTOP_SSH_TARGET_JSON) return null;
	if (env.PI_DESKTOP_HOST_KIND !== "ssh") {
		throw new Error("pi-codex host routing patch did not load. Refusing local fallback; disable SSH mode or use a compatible runtime.");
	}
	let target;
	try { target = JSON.parse(env.PI_DESKTOP_SSH_TARGET_JSON); }
	catch { throw new Error("Missing or invalid SSH host metadata"); }
	if (!target || typeof target !== "object" || Array.isArray(target)) throw new Error("Invalid SSH host metadata");
	return target;
}

export function buildSshInvocation(target, env = process.env) {
	const host = target.sshAlias || target.sshHost;
	if (typeof host !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_.@:\[\]-]*$/.test(host) || host.length > 255) {
		throw new Error("Invalid SSH alias/host (use an SSH config alias or user@host)");
	}
	const args = ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
		"-o", "ForwardAgent=no", "-o", "GSSAPIDelegateCredentials=no", "-o", "ClearAllForwardings=yes",
		"-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"];
	// An alias owns User/Port/IdentityFile/ProxyCommand in ~/.ssh/config. Do not
	// replace its effective values with Desktop's default port or stale fields.
	if (!target.sshAlias) {
		if (target.sshPort != null) {
			if (!Number.isInteger(target.sshPort) || target.sshPort < 1 || target.sshPort > 65535) throw new Error("Invalid SSH port");
			args.push("-p", String(target.sshPort));
		}
		if (target.identity) {
			if (typeof target.identity !== "string" || /[\r\n\0]/.test(target.identity)) throw new Error("Invalid SSH identity path");
			const identity = target.identity.startsWith("~/") ? path.join(os.homedir(), target.identity.slice(2)) : target.identity;
			if (!path.isAbsolute(identity) || identity === "/") throw new Error("SSH identity must be an absolute file path");
			args.push("-i", identity);
		}
	}
	const custom = env.PI_DESKTOP_REMOTE_BRIDGE;
	if (custom !== undefined && (typeof custom !== "string" || !custom.startsWith("/") || custom === "/" || /[\r\n\0]/.test(custom))) {
		throw new Error("PI_DESKTOP_REMOTE_BRIDGE must be an absolute file path, not /");
	}
	const script = [
		'umask 077',
		'export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"',
		`BRIDGE=${custom ? quote(custom) : '"$HOME/.local/share/pi-desktop/pi-app-server.mjs"'}`,
		'command -v node >/dev/null 2>&1 || { echo "pi-codex: remote Node.js is missing" >&2; exit 127; }',
		'node -e \'const [a,b]=process.versions.node.split(".").map(Number); if(a<22||(a===22&&b<19))process.exit(1)\' || { echo "pi-codex: remote Node.js >=22.19 is required" >&2; exit 1; }',
		'test -f "$BRIDGE" || { echo "pi-codex: remote bridge is not deployed ($BRIDGE)" >&2; exit 127; }',
		'export PI_CODING_AGENT_DIR="${PI_DESKTOP_AGENT_DIR:-$HOME/.pi/agent}"',
		'export CODEX_HOME="${PI_DESKTOP_CODEX_HOME:-$HOME/.pi/codex-app}"',
		'unset NODE_OPTIONS PI_DESKTOP_ENABLE_SSH PI_DESKTOP_HOST_KIND PI_DESKTOP_SSH_TARGET_JSON CODEX_APP_TOOLS_PIPE_PATH',
		'export PI_DESKTOP_REMOTE=1',
		'export PI_DESKTOP_SOCKET="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/pi-desktop/host.sock"',
		'cd "$HOME" || exit 1',
		'exec node "$BRIDGE" --attach',
	].join('; ');
	return { command: "ssh", args: [...args, "--", host, `sh -c ${quote(script)}`] };
}

export function requireRemoteSdkVersion(sdk, version, env = process.env) {
	if (env.PI_DESKTOP_REMOTE === "1" && version !== "0.85.1") {
		throw new Error(`Remote Pi SDK ${version} is not validated; this bridge requires 0.85.1. No automatic upgrade was performed.`);
	}
	if (env.PI_DESKTOP_REMOTE === "1" && typeof sdk.createAgentSessionFromServices !== "function") {
		throw new Error("Remote Pi SDK is missing createAgentSessionFromServices");
	}
}

export function relaySsh(target, { env = process.env, input = process.stdin, output = process.stdout,
	errorOutput = process.stderr, spawnChild = spawn, startupTimeoutMs = 30_000 } = {}) {
	const invocation = buildSshInvocation(target, env);
	// SSH owns only the attachment. Remote systemd owns the PiHost process.
	// Never replay an uncertain prompt after transport failure.
	const childEnv = { ...env };
	delete childEnv.NODE_OPTIONS;
	return new Promise((resolve, reject) => {
		const child = spawnChild(invocation.command, invocation.args, { stdio: ["pipe", "pipe", "pipe"], env: childEnv });
		let failure;
		let killTimer;
		const stop = (error) => {
			failure ||= error;
			child.kill("SIGTERM");
			killTimer ||= setTimeout(() => child.kill("SIGKILL"), 2000);
			killTimer.unref?.();
		};
		const timer = setTimeout(() => stop(new Error("Remote pi-codex startup timed out")), startupTimeoutMs);
		const onOutput = () => clearTimeout(timer);
		const onError = (error) => stop(error);
		const onSignal = () => stop(new Error("SSH connection cancelled"));
		for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, onSignal);
		child.stdout.once("data", onOutput);
		child.stdin.on("error", onError);
		child.stdout.on("error", onError);
		child.stderr.on("error", onError);
		output.on("error", onError);
		input.on("error", onError);
		child.on("error", onError);
		input.pipe(child.stdin);
		child.stdout.pipe(output, { end: false });
		child.stderr.pipe(errorOutput, { end: false });
		child.once("close", (code, signal) => {
			clearTimeout(timer); clearTimeout(killTimer);
			for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.removeListener(name, onSignal);
			input.unpipe(child.stdin); child.stdout.unpipe(output); child.stderr.unpipe(errorOutput);
			input.removeListener("error", onError); output.removeListener("error", onError);
			if (failure) reject(failure);
			else if (code !== 0) reject(new Error(`Remote pi-codex exited (${code ?? signal}); not retrying or falling back locally`));
			else resolve();
		});
	});
}

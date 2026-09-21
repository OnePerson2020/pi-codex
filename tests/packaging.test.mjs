import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const macOS = process.platform === "darwin";

function run(command, args, options = {}) {
	return execFileSync(command, args, { cwd: root, encoding: "utf8", stdio: "pipe", ...options });
}

function shellFailure(script) {
	try {
		run("sh", [script]);
		return null;
	} catch (error) {
		return `${error.stdout || ""}${error.stderr || ""}`;
	}
}

test("release bootstraps stay POSIX shell and keep their platform guards", { skip: !macOS }, () => {
	for (const script of ["install.sh", "install-linux.sh"]) {
		assert.doesNotThrow(() => run("sh", ["-n", path.join(root, script)]), `${script} is not valid POSIX shell`);
	}
	// install.sh would really install on macOS, so only its counterpart is executed here.
	assert.match(shellFailure(path.join(root, "install-linux.sh")) || "", /Linux execution host/);
});

test("DMG image carries a runnable installer and the whole bridge payload", { skip: !macOS }, () => {
	const work = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dmg-"));
	const image = path.join(work, "pi-codex.dmg");
	const mount = path.join(work, "mnt");
	fs.mkdirSync(mount);
	try {
		run("sh", [path.join(root, "scripts/package-mac-dmg.sh"), image]);
		run("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mount, image]);
		try {
			const installer = path.join(mount, "Install pi-codex.command");
			assert.ok(fs.statSync(installer).mode & 0o100, "installer is not executable");
			assert.doesNotThrow(() => run("sh", ["-n", installer]), "installer is not valid POSIX shell");
			for (const required of ["install-mac-app", "pi-app-server.mjs", "src/pi-host.mjs", "scripts/enable-private-runtime.py", "mac-app/Pi.icns"]) {
				assert.ok(fs.existsSync(path.join(mount, ".payload", required)), `payload is missing ${required}`);
			}
		} finally {
			run("hdiutil", ["detach", mount]);
		}
	} finally {
		fs.rmSync(work, { recursive: true, force: true });
	}
});

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function packageRootFromExecutable(executable) {
	// npm entry points may be dist/cli.js or dist/bundle/cli.js.
	let directory = path.dirname(fs.realpathSync(executable));
	for (;;) {
		const manifest = path.join(directory, "package.json");
		if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, "utf8")).name === "@earendil-works/pi-coding-agent") return directory;
		const parent = path.dirname(directory);
		if (parent === directory) throw new Error(`Cannot locate Pi package for ${executable}`);
		directory = parent;
	}
}

function candidatePackageRoots() {
	const roots = [];
	// A Linux deployment owns its SDK independently of the user's global Pi.
	const bundled = path.resolve(import.meta.dirname, "../sdk/node_modules/@earendil-works/pi-coding-agent");
	if (fs.existsSync(path.join(bundled, "package.json"))) roots.push(bundled);
	if (process.env.PI_PACKAGE_DIR) roots.push(process.env.PI_PACKAGE_DIR);
	const executables = [
		process.env.PI_BIN,
		"/opt/homebrew/bin/pi",
		"/usr/local/bin/pi",
		path.join(process.env.HOME || "", ".local/bin/pi"),
		...(process.env.PATH || "").split(path.delimiter).map((directory) => path.join(directory, "pi")),
	].filter(Boolean);
	for (const executable of executables) {
		try {
			if (fs.existsSync(executable)) roots.push(packageRootFromExecutable(executable));
		} catch {
			// Ignore broken candidates and keep searching.
		}
	}
	return [...new Set(roots)];
}

export async function loadPiSdk() {
	const failures = [];
	for (const root of candidatePackageRoots()) {
		const sdkPath = path.join(root, "dist/index.js");
		const aiPath = path.join(
			root,
			"node_modules/@earendil-works/pi-ai/dist/index.js",
		);
		const outputGuardPath = path.join(root, "dist/core/output-guard.js");
		try {
			const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
			const [sdk, ai, outputGuard] = await Promise.all([
				import(pathToFileURL(sdkPath).href),
				import(pathToFileURL(aiPath).href),
				import(pathToFileURL(outputGuardPath).href),
			]);
			return { ...sdk, VERSION: manifest.version, Type: ai.Type, outputGuard, packageRoot: root };
		} catch (error) {
			failures.push(`${root}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	throw new Error(
		[
			"Cannot load @earendil-works/pi-coding-agent.",
			"Set PI_PACKAGE_DIR to the installed package root.",
			...failures,
		].join("\n"),
	);
}

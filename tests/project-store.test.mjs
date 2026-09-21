import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProjectStore, projectIdForThread } from "../src/project-store.mjs";

test("projects and explicit thread assignments survive a store restart", async (t) => {
	const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-app-pi-store-"));
	t.after(() => fs.rm(codexHome, { recursive: true, force: true }));
	const firstStore = new ProjectStore({
		codexHome,
		now: () => 100,
		createId: () => "project-1",
	});
	const created = await firstStore.create({
		name: "project",
		roots: [{ path: path.join(codexHome, "project") }],
		idempotencyKey: "import-1",
	});
	await firstStore.assignThread("thread-1", created.project.id);

	const reloaded = await new ProjectStore({ codexHome }).snapshot();
	assert.equal(reloaded.projects[0].id, "project-1");
	assert.equal(reloaded.threadProjects["thread-1"], "project-1");
});

test("automatic project assignment selects the longest matching root", async () => {
	const state = {
		projects: [
			{ id: "parent", roots: [{ path: "/tmp/work" }] },
			{ id: "nested", roots: [{ path: "/tmp/work/nested" }] },
		],
		threadProjects: {},
	};
	assert.equal(projectIdForThread(state, "thread-1", "/tmp/work/nested/repo"), "nested");
	assert.equal(projectIdForThread(state, "thread-2", "/tmp/workbench"), null);
});

test("an explicit null assignment overrides cwd-based project matching", async () => {
	const state = {
		projects: [{ id: "project-1", roots: [{ path: "/tmp/work" }] }],
		threadProjects: { "thread-1": null },
	};
	assert.equal(projectIdForThread(state, "thread-1", "/tmp/work"), null);
});

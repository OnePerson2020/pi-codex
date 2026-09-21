import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const STORE_VERSION = 1;

export class ProjectStore {
	constructor({ codexHome, now = () => Math.floor(Date.now() / 1000), createId = () => crypto.randomUUID() }) {
		this.filePath = path.join(path.resolve(codexHome), "pi-desktop-projects.json");
		this.now = now;
		this.createId = createId;
		this.writeTail = Promise.resolve();
	}

	async snapshot() {
		return structuredClone(await this.load());
	}

	async create(params, imported = false) {
		return this.mutate((state) => {
			const idempotencyKey = requireString(params.idempotencyKey, "idempotencyKey");
			const existingId = state.idempotency[idempotencyKey];
			const existing = state.projects.find((project) => project.id === existingId);
			if (existing) return { project: existing, created: false };

			const timestamp = this.now();
			const project = {
				id: this.createId(),
				name: normalizeName(params.name, params.roots),
				roots: normalizeRoots(params.roots),
				metadata: normalizeMetadata(params.metadata),
				position: state.projects.length,
				createdAt: timestamp,
				updatedAt: timestamp,
			};
			state.projects.push(project);
			state.idempotency[idempotencyKey] = project.id;
			if (imported) {
				for (const threadId of normalizeThreadIds(params.threads)) {
					state.threadProjects[threadId] = project.id;
				}
			}
			return { project, created: true };
		});
	}

	async update(params) {
		return this.mutate((state) => {
			const project = requireProject(state, params.projectId);
			if (Object.hasOwn(params, "name") && params.name !== null) {
				project.name = normalizeName(params.name, project.roots);
			}
			if (Object.hasOwn(params, "roots") && params.roots !== null) {
				project.roots = normalizeRoots(params.roots);
			}
			if (Object.hasOwn(params, "metadata") && params.metadata !== null) {
				project.metadata = normalizeMetadata(params.metadata);
			}
			project.updatedAt = this.now();
			return { project };
		});
	}

	async move(params) {
		return this.mutate((state) => {
			const project = requireProject(state, params.projectId);
			const remaining = state.projects.filter((candidate) => candidate.id !== project.id);
			let index = remaining.length;
			if (params.beforeProjectId) {
				index = remaining.findIndex((candidate) => candidate.id === params.beforeProjectId);
				if (index < 0) throw new Error(`Project not found: ${params.beforeProjectId}`);
			}
			remaining.splice(index, 0, project);
			state.projects = remaining;
			normalizePositions(state.projects);
			return {};
		});
	}

	async delete(projectId) {
		return this.mutate((state) => {
			requireProject(state, projectId);
			state.projects = state.projects.filter((project) => project.id !== projectId);
			normalizePositions(state.projects);
			for (const [threadId, assignedProjectId] of Object.entries(state.threadProjects)) {
				if (assignedProjectId === projectId) state.threadProjects[threadId] = null;
			}
			for (const [key, id] of Object.entries(state.idempotency)) {
				if (id === projectId) delete state.idempotency[key];
			}
			return {};
		});
	}

	async assignThread(threadId, projectId) {
		return this.mutate((state) => {
			if (projectId !== null) requireProject(state, projectId);
			state.threadProjects[requireString(threadId, "threadId")] = projectId;
			return {};
		});
	}

	async writeDesktopSettings(edits) {
		const allowed = {
			followUpQueueMode: ["queue", "steer", "interrupt"],
			conversationDetailMode: ["STEPS_PROSE", "STEPS_COMMANDS", "STEPS_EXECUTION"],
		};
		if (!Array.isArray(edits) || !edits.length) throw new Error("pi-codex does not support this config write");
		for (const edit of edits) {
			const key = edit?.keyPath?.startsWith("desktop.") ? edit.keyPath.slice(8) : "";
			if (!Object.hasOwn(allowed, key) || !["replace", "upsert"].includes(edit.mergeStrategy) ||
				(edit.value !== null && !allowed[key].includes(edit.value))) {
				throw new Error(`pi-codex does not support config write: ${edit?.keyPath}`);
			}
		}
		return this.mutate((state) => {
			for (const { keyPath, value } of edits) {
				const key = keyPath.slice(8);
				if (value === null) delete state.desktop[key];
				else state.desktop[key] = value;
			}
			return {};
		});
	}

	async setArchived(threadId, archived) {
		return this.mutate((state) => {
			const id = requireString(threadId, "threadId");
			state.archivedThreads = state.archivedThreads.filter((value) => value !== id);
			if (archived) state.archivedThreads.push(id);
			return {};
		});
	}

	async removeThread(threadId) {
		return this.mutate((state) => {
			delete state.threadProjects[threadId];
			state.archivedThreads = state.archivedThreads.filter((id) => id !== threadId);
			return {};
		});
	}

	async load() {
		try {
			return normalizeState(JSON.parse(await fs.readFile(this.filePath, "utf8")));
		} catch (error) {
			if (error?.code === "ENOENT") return emptyState();
			throw new Error(`Failed to read pi-codex projects: ${error.message}`);
		}
	}

	async mutate(callback) {
		const operation = this.writeTail.then(async () => {
			await fs.mkdir(path.dirname(this.filePath), { recursive: true });
			const lockPath = `${this.filePath}.lock`;
			let lock;
			try {
				lock = await fs.open(lockPath, "wx", 0o600);
			} catch (error) {
				if (error.code === "EEXIST") throw new Error(`pi-codex projects are locked: ${lockPath}. Retry; after a crash, verify no writer is running before removing the lock.`);
				throw error;
			}
			try {
				// ponytail: fail closed on a stale lock; add verified owner recovery only if needed.
				await lock.writeFile(`${process.pid}\n`);
				const state = await this.load();
				const result = callback(state);
				normalizePositions(state.projects);
				await this.write(state);
				return structuredClone(result);
			} finally {
				await lock.close();
				await fs.rm(lockPath);
			}
		});
		this.writeTail = operation.catch(() => {});
		return operation;
	}

	async write(state) {
		await fs.mkdir(path.dirname(this.filePath), { recursive: true });
		const temporaryPath = `${this.filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
		try {
			await fs.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
				encoding: "utf8",
				mode: 0o600,
			});
			await fs.rename(temporaryPath, this.filePath);
		} finally {
			await fs.rm(temporaryPath, { force: true });
		}
	}
}

export function projectIdForThread(state, threadId, cwd) {
	if (Object.hasOwn(state.threadProjects, threadId)) {
		const assigned = state.threadProjects[threadId];
		return assigned !== null && state.projects.some((project) => project.id === assigned)
			? assigned
			: null;
	}
	if (typeof cwd !== "string" || !cwd) return null;
	const resolvedCwd = path.resolve(cwd);
	let match = null;
	let matchLength = -1;
	for (const project of state.projects) {
		for (const root of project.roots) {
			if (isWithinRoot(resolvedCwd, root.path) && root.path.length > matchLength) {
				match = project.id;
				matchLength = root.path.length;
			}
		}
	}
	return match;
}

function emptyState() {
	return {
		version: STORE_VERSION,
		projects: [],
		threadProjects: {},
		archivedThreads: [],
		desktop: {},
		idempotency: {},
	};
}

function normalizeState(value) {
	if (!value || typeof value !== "object") return emptyState();
	const state = emptyState();
	if (value.version !== STORE_VERSION) throw new Error(`Unsupported project store version: ${value.version}`);
	state.archivedThreads = normalizeThreadIds(value.archivedThreads);
	state.desktop = normalizeMetadata(value.desktop);
	state.projects = (Array.isArray(value.projects) ? value.projects : [])
		.filter((project) => project && typeof project.id === "string")
		.map((project, index) => ({
			id: project.id,
			name: normalizeName(project.name, project.roots),
			roots: normalizeRoots(project.roots),
			metadata: normalizeMetadata(project.metadata),
			position: Number.isFinite(project.position) ? project.position : index,
			createdAt: finiteTimestamp(project.createdAt),
			updatedAt: finiteTimestamp(project.updatedAt),
		}))
		.sort((left, right) => left.position - right.position);
	normalizePositions(state.projects);
	state.threadProjects =
		value.threadProjects && typeof value.threadProjects === "object"
			? Object.fromEntries(
					Object.entries(value.threadProjects).filter(
						([threadId, projectId]) =>
							typeof threadId === "string" &&
							(projectId === null || typeof projectId === "string"),
					),
				)
			: {};
	state.idempotency =
		value.idempotency && typeof value.idempotency === "object"
			? Object.fromEntries(
					Object.entries(value.idempotency).filter(
						([key, projectId]) => typeof key === "string" && typeof projectId === "string",
					),
				)
			: {};
	return state;
}

function requireProject(state, projectId) {
	const project = state.projects.find((candidate) => candidate.id === projectId);
	if (!project) throw new Error(`Project not found: ${projectId}`);
	return project;
}

function normalizeName(value, roots) {
	const name = typeof value === "string" ? value.trim() : "";
	if (name) return name;
	const root = Array.isArray(roots) ? roots[0]?.path : null;
	return typeof root === "string" && root ? path.basename(root) : "Project";
}

function normalizeRoots(value) {
	const roots = [];
	const seen = new Set();
	for (const root of Array.isArray(value) ? value : []) {
		if (!root || typeof root.path !== "string" || !root.path) continue;
		const rootPath = path.resolve(root.path);
		if (seen.has(rootPath)) continue;
		seen.add(rootPath);
		roots.push({ path: rootPath });
	}
	return roots;
}

function normalizeMetadata(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return Object.fromEntries(
		Object.entries(value).filter(
			([key, item]) => typeof key === "string" && typeof item === "string",
		),
	);
}

function normalizeThreadIds(value) {
	return [
		...new Set(
			(Array.isArray(value) ? value : []).filter(
				(threadId) => typeof threadId === "string" && threadId,
			),
		),
	];
}

function normalizePositions(projects) {
	projects.forEach((project, index) => {
		project.position = index;
	});
}

function finiteTimestamp(value) {
	return Number.isFinite(value) ? Math.trunc(value) : Math.floor(Date.now() / 1000);
}

function requireString(value, name) {
	if (typeof value !== "string" || !value) throw new Error(`${name} is required`);
	return value;
}

function isWithinRoot(candidate, root) {
	const relative = path.relative(path.resolve(root), candidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

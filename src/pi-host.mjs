import path from "node:path";
import fs from "node:fs/promises";
import {
	blankThread,
	codexResultToPi,
	contentText,
	contentToUserInput,
	normalizeCodexInput,
	completeToolItem,
	terminalState,
	toolItem,
	entriesToTurns,
	flattenDynamicTools,
	inputToPi,
	jsonRpcNotification,
	modelToCodex,
	newId,
	nowMilliseconds,
	nowSeconds,
	piModelId,
	threadFromSessionInfo,
	usageBreakdown,
} from "./protocol.mjs";
import { ProjectStore, projectIdForThread } from "./project-store.mjs";
import { acquireSessionGuard, assertSessionAvailable } from "./session-guard.mjs";
import { sessionLivenessRegistry } from "./session-liveness.mjs";
import { piWebLabel } from "./pi-web-status.mjs";

const REASONING_LEVELS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const PROJECT_PROTOCOL_VERSION = "0.148.0-alpha.21";
const IDLE_DISPOSE_DELAY_MS = 100;
const LIVENESS_RECHECK_MS = 1000;

export class PiHost {
	constructor({
		sdk,
		send,
		cwd = process.cwd(),
		agentDir,
		piVersion = "unknown",
		inlineExtensions = [],
		piWebStatus = null,
		codexHome,
		protocolVersion = PROJECT_PROTOCOL_VERSION,
	}) {
		this.sdk = sdk;
		this.send = send;
		this.cwd = path.resolve(cwd);
		this.agentDir = agentDir || sdk.getAgentDir();
		this.piVersion = piVersion;
		this.protocolVersion = protocolVersion;
		this.codexHome = path.resolve(
			codexHome || process.env.CODEX_HOME || path.join(this.agentDir, "codex-app"),
		);
		this.inlineExtensions = inlineExtensions;
		this.piWebStatus = piWebStatus;
		this.webThreads = new Map();
		this.threads = new Map();
		this.views = new Map();
		this.opening = new Map();
		this.starting = new Map();
		this.dynamicCalls = new Map();
		this.uiRequests = new Map();
		this.resolvedRequests = new Map();
		this.executing = new Map();
		this.sessionLiveness = sessionLivenessRegistry();
		this.projectStore = new ProjectStore({ codexHome: this.codexHome });
		this.trustStore = new sdk.ProjectTrustStore(this.agentDir);
		this.initialized = false;
		this.closing = false;
	}

	async handle(message) {
		if (!message || typeof message !== "object") return;
		if (message.method && Object.hasOwn(message, "id")) {
			await this.handleRequest(message);
			return;
		}
		if (message.method === "initialized") {
			this.initialized = true;
			for (const [requestId, threadId] of this.resolvedRequests) {
				this.send(jsonRpcNotification("serverRequest/resolved", { requestId, threadId }));
			}
			return;
		}
		if (Object.hasOwn(message, "id")) {
			const pending = this.dynamicCalls.get(String(message.id));
			if (pending) {
				pending.finish(message);
				return;
			}
			const uiPending = this.uiRequests.get(String(message.id));
			if (uiPending) {
				uiPending.finish(message);
			}
		}
	}

	async handleRequest(request) {
		try {
			if (this.closing) throw new Error("pi-codex adapter is shutting down");
			const result = await this.dispatch(request.method, request.params || {});
			this.send({ jsonrpc: "2.0", id: request.id, result: result ?? {} });
		} catch (error) {
			this.send({
				jsonrpc: "2.0",
				id: request.id,
				error: {
					code: -32000,
					message: error instanceof Error ? error.message : String(error),
				},
			});
		}
	}

	async dispatch(method, params) {
		switch (method) {
			case "initialize":
				return {
					userAgent: `pi-codex/${this.protocolVersion}`,
					codexHome: this.codexHome,
					platformFamily: process.platform === "win32" ? "windows" : "unix",
					platformOs: platformOs(),
				};
			case "server/diagnostics":
				return {
					process: {
						id: process.pid,
						residentMemoryBytes: process.memoryUsage().rss,
						physicalFootprintBytes: null,
					},
					gauges: [],
				};
			case "account/read":
			case "auth/status":
				return {
					requiresOpenaiAuth: false,
					account: { type: "amazonBedrock" },
					isWorkspaceOwner: null,
					workspaceRole: null,
				};
			case "getAuthStatus":
				return {
					authMethod: "amazonBedrock",
					requiresOpenaiAuth: false,
				};
			case "model/list":
				return this.modelList(params);
			case "config/read":
				return this.configRead();
			case "configRequirements/read":
				return { requirements: null };
			case "config/batchWrite":
			case "config/value/write":
				if (params.filePath || params.expectedVersion) throw new Error("pi-codex does not support targeted/versioned Codex config writes");
				await this.writeConfig(method === "config/batchWrite" ? params.edits : [params]);
				return { status: "ok", filePath: this.projectStore.filePath, version: "pi-desktop-1", overriddenMetadata: null };
			case "collaborationMode/list":
				return { data: [] };
			case "permissionProfile/list":
				return {
					data: [
						{
							id: ":danger-full-access",
							description: "Pi runs with the permissions of the current operating-system user.",
						},
					],
					nextCursor: null,
				};
			case "experimentalFeature/list":
			case "app/list":
				return { data: [], nextCursor: null };
			case "app/read":
				return {
					apps: [],
					missingAppIds: [
						...new Set(
							(Array.isArray(params.appIds) ? params.appIds : []).filter(
								(appId) => typeof appId === "string",
							),
						),
					],
				};
			case "app/installed":
				return { apps: [] };
			case "experimentalFeature/enablement/set":
				return { enablement: {} };
			case "externalAgentConfig/detect":
				return { items: [], connectors: [] };
			case "externalAgentConfig/import/readHistories":
				return { data: [], connectors: [] };
			case "plugin/list":
			case "plugin/installed":
				return { featuredPluginIds: [], marketplaceLoadErrors: [], marketplaces: [] };
			case "plugin/install":
			case "plugin/uninstall":
				throw new Error("pi-codex does not support Codex plugin installation; use pi install/remove");
			case "marketplace/add":
				return {
					alreadyAdded: true,
					marketplaceName: params.name || "openai-bundled",
					installedRoot: params.path || params.source || this.agentDir,
				};
			case "marketplace/remove":
				return { marketplaceName: params.marketplaceName || "", installedRoot: null };
			case "marketplace/upgrade":
				return {
					selectedMarketplaces: params.marketplaceName ? [params.marketplaceName] : [],
					upgradedRoots: [],
					errors: [],
				};
			case "hooks/list":
				return { data: [] };
			case "skills/list":
				return this.skillsList(params);
			case "mcpServerStatus/list":
				return { data: [], nextCursor: null };
			case "account/rateLimits/read":
				return { rateLimits: null };
			case "remoteControl/status/read":
				return { status: "disconnected" };
			case "fs/readFile":
				try {
					return { dataBase64: (await fs.readFile(params.path)).toString("base64") };
				} catch (error) {
					if (error?.code === "ENOENT") {
						return { dataBase64: Buffer.from("{}").toString("base64") };
					}
					throw error;
				}
			case "fs/writeFile":
				await fs.mkdir(path.dirname(params.path), { recursive: true });
				await fs.writeFile(params.path, Buffer.from(params.dataBase64 || "", "base64"));
				return {};
			case "fs/createDirectory":
				await fs.mkdir(params.path, { recursive: params.recursive !== false });
				return {};
			case "fs/readDirectory": {
				const entries = await fs.readdir(params.path, { withFileTypes: true });
				return {
					entries: entries.map((entry) => ({
						fileName: entry.name,
						isDirectory: entry.isDirectory(),
						isFile: entry.isFile(),
					})),
				};
			}
			case "fs/getMetadata": {
				const [stats, linkStats] = await Promise.all([fs.stat(params.path), fs.lstat(params.path)]);
				return {
					isDirectory: stats.isDirectory(),
					isFile: stats.isFile(),
					isSymlink: linkStats.isSymbolicLink(),
					sizeBytes: stats.size,
					createdAtMs: Math.trunc(stats.birthtimeMs || 0),
					modifiedAtMs: Math.trunc(stats.mtimeMs || 0),
				};
			}
			case "fs/copy":
				await fs.cp(params.sourcePath, params.destinationPath, {
					recursive: Boolean(params.recursive),
					errorOnExist: true,
				});
				return {};
			case "fs/remove":
				await fs.rm(params.path, {
					force: params.force !== false,
					recursive: params.recursive !== false,
				});
				return {};
			case "thread/start":
				return this.startThread(params);
			case "thread/resume":
				return this.resumeThread(params);
			case "thread/fork":
				return this.forkThread(params);
			case "thread/inject_items":
				return this.injectItems(params);
			case "thread/read":
				return this.readThread(params);
			case "thread/list":
				return this.listThreads(params);
			case "thread/loaded/list":
				return this.listLoadedThreads();
			case "thread/name/set":
				return this.setThreadName(params);
			case "thread/metadata/update":
				return this.updateThreadMetadata(params);
			case "thread/archive":
				return this.archiveThread(params, true);
			case "thread/unarchive":
				return this.archiveThread(params, false);
			case "thread/delete":
				return this.deleteThread(params);
			case "thread/unsubscribe":
				return {};
			case "thread/settings/update":
				return this.updateThreadSettings(params);
			case "thread/contextUsage":
				return this.contextUsage(params);
			case "thread/compact/start":
				return this.compactThread(params);
			case "thread/revert":
				return this.revertThread(params);
			case "thread/rollback":
				return this.rollbackThread(params);
			case "thread/turns/list":
				return this.listTurns(params);
			case "thread/items/list":
				return this.listItems(params);
			case "turn/start":
				return this.startTurn(params);
			case "turn/steer":
				return this.steerTurn(params);
			case "turn/interrupt":
				return this.interruptTurn(params);
			case "turn/removePendingInput":
				throw new Error("pi-codex does not support removing individual queued inputs");
			case "project/list":
				return this.listProjects(params);
			case "project/read":
				return this.readProject(params);
			case "project/create":
				return this.createProject(params, false);
			case "project/import":
				return this.createProject(params, true);
			case "project/update":
				return this.updateProject(params);
			case "project/move":
				return this.moveProject(params);
			case "project/delete":
				return this.deleteProject(params);
			default:
				throw new Error(`pi-codex adapter does not implement ${method}`);
		}
	}

	async modelList() {
		const services = await this.ensureCatalogServices();
		const selected = services.settingsManager.getDefaultProvider() && services.settingsManager.getDefaultModel()
			? `${services.settingsManager.getDefaultProvider()}/${services.settingsManager.getDefaultModel()}`
			: null;
		return {
			data: services.modelRuntime
				.getAvailableSnapshot()
				.map((model) => modelToCodex(model, piModelId(model) === selected)),
			nextCursor: null,
		};
	}

	async configRead() {
		const services = await this.ensureCatalogServices();
		const provider = services.settingsManager.getDefaultProvider() || null;
		const modelId = services.settingsManager.getDefaultModel() || null;
		const { desktop } = await this.projectStore.snapshot();
		return {
			config: {
				desktop,
				model: provider && modelId ? `${provider}/${modelId}` : modelId,
				model_provider: "pi",
				model_reasoning_effort: services.settingsManager.getDefaultThinkingLevel() || "medium",
				sandbox_mode: "danger-full-access",
				approval_policy: "never",
				approvals_reviewer: "user",
				harness_mode: "auto",
			},
			origins: {},
			layers: null,
		};
	}

	async writeConfig(edits) {
		if (!Array.isArray(edits) || !edits.length) throw new Error("pi-codex does not support this config write");
		if (edits.every((edit) => edit?.keyPath?.startsWith("desktop."))) {
			return this.projectStore.writeDesktopSettings(edits);
		}
		const allowed = new Set(["model", "model_reasoning_effort"]);
		const invalid = edits.find((edit) => !allowed.has(edit?.keyPath) || !["replace", "upsert"].includes(edit.mergeStrategy));
		if (invalid) throw new Error(`pi-codex does not support config write: ${invalid?.keyPath}`);
		const services = await this.ensureCatalogServices();
		const modelValue = edits.findLast((edit) => edit.keyPath === "model")?.value;
		const effortValue = edits.findLast((edit) => edit.keyPath === "model_reasoning_effort")?.value;
		if (modelValue !== undefined && (typeof modelValue !== "string" || !modelValue)) throw new Error(`Pi model not available: ${modelValue}`);
		const model = modelValue === undefined ? undefined : this.resolveModel(services, modelValue, "pi");
		if (modelValue !== undefined && !model) throw new Error(`Pi model not available: ${modelValue}`);
		const effort = effortValue === undefined ? undefined : normalizeThinking(effortValue);
		if (effortValue !== undefined && !effort) throw new Error(`Unsupported reasoning effort: ${effortValue}`);
		if (model) services.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
		if (effort) services.settingsManager.setDefaultThinkingLevel(effort);
		await services.settingsManager.flush();
		const errors = services.settingsManager.drainErrors();
		if (errors.length) throw errors[0].error;
	}

	async skillsList(params) {
		const cwd = path.resolve(params.cwd || this.cwd);
		const services = await this.createServices(cwd);
		const result = services.resourceLoader.getSkills();
		return {
			data: [
				{
					cwd,
					skills: result.skills.map((skill) => ({
						name: skill.name,
						description: skill.description,
						path: skill.filePath,
						enabled: true,
						scope: skill.sourceInfo.scope === "project" ? "repo" : "user",
						shortDescription: null,
						interface: null,
						dependencies: null,
					})),
					errors: result.diagnostics.map((diagnostic) => ({
						path: "",
						message: diagnostic.message,
					})),
				},
			],
		};
	}

	async listProjects(params) {
		const [state, sessions] = await Promise.all([
			this.projectStore.snapshot(),
			this.sdk.SessionManager.listAll(),
		]);
		const projects = state.projects.map((project) => this.projectObject(project, state, sessions));
		const sortKey = params.sortKey === "recencyAt" ? "recencyAt" : "position";
		const direction =
			params.sortDirection === "asc" || params.sortDirection === "desc"
				? params.sortDirection
				: sortKey === "recencyAt"
					? "desc"
					: "asc";
		projects.sort((left, right) => {
			if (sortKey === "recencyAt") {
				if (left.recencyAt === null) return right.recencyAt === null ? left.position - right.position : 1;
				if (right.recencyAt === null) return -1;
			}
			const difference = left[sortKey] - right[sortKey];
			return (direction === "desc" ? -1 : 1) * difference || left.position - right.position;
		});
		const limit = Math.max(1, Number(params.limit) || 50);
		const start = Math.max(0, Number(params.cursor) || 0);
		return {
			data: projects.slice(start, start + limit),
			nextCursor: start + limit < projects.length ? String(start + limit) : null,
		};
	}

	async readProject(params) {
		const [state, sessions] = await Promise.all([
			this.projectStore.snapshot(),
			this.sdk.SessionManager.listAll(),
		]);
		const project = state.projects.find((candidate) => candidate.id === params.projectId);
		if (!project) throw new Error(`Project not found: ${params.projectId}`);
		return { project: this.projectObject(project, state, sessions) };
	}

	async createProject(params, imported) {
		const result = await this.projectStore.create(params, imported);
		const [state, sessions] = await Promise.all([
			this.projectStore.snapshot(),
			this.sdk.SessionManager.listAll(),
		]);
		await this.refreshLoadedThreadProjects(state);
		if (result.created) {
			this.send(jsonRpcNotification("project/changed", {
				projectId: result.project.id,
				changeType: "created",
			}));
		}
		return { project: this.projectObject(result.project, state, sessions) };
	}

	async updateProject(params) {
		const result = await this.projectStore.update(params);
		const [state, sessions] = await Promise.all([
			this.projectStore.snapshot(),
			this.sdk.SessionManager.listAll(),
		]);
		await this.refreshLoadedThreadProjects(state);
		this.send(jsonRpcNotification("project/changed", {
			projectId: result.project.id,
			changeType: "updated",
		}));
		return { project: this.projectObject(result.project, state, sessions) };
	}

	async moveProject(params) {
		await this.projectStore.move(params);
		this.send(jsonRpcNotification("project/changed", {
			projectId: params.projectId,
			changeType: "updated",
		}));
		return {};
	}

	async deleteProject(params) {
		await this.projectStore.delete(params.projectId);
		const state = await this.projectStore.snapshot();
		await this.refreshLoadedThreadProjects(state);
		this.send(jsonRpcNotification("project/changed", {
			projectId: params.projectId,
			changeType: "deleted",
		}));
		return {};
	}

	projectObject(project, state, sessions) {
		let recencyAt = null;
		const seen = new Set();
		for (const info of sessions) {
			seen.add(info.id);
			if (projectIdForThread(state, info.id, info.cwd) !== project.id) continue;
			const modified = Math.floor(new Date(info.modified).getTime() / 1000);
			if (Number.isFinite(modified)) recencyAt = Math.max(recencyAt ?? modified, modified);
		}
		for (const runtime of this.threads.values()) {
			if (seen.has(runtime.id) || projectIdForThread(state, runtime.id, runtime.cwd) !== project.id) continue;
			recencyAt = Math.max(recencyAt ?? runtime.updatedAt, runtime.updatedAt);
		}
		return { ...project, recencyAt };
	}

	async refreshLoadedThreadProjects(state) {
		for (const runtime of this.threads.values()) {
			const projectId =
				!runtime.session.sessionFile && runtime.projectAssignmentExplicit
					? runtime.projectId &&
						state.projects.some((project) => project.id === runtime.projectId)
						? runtime.projectId
						: null
					: projectIdForThread(state, runtime.id, runtime.cwd);
			if (runtime.projectId === projectId) continue;
			runtime.projectId = projectId;
			this.send(jsonRpcNotification("thread/project/updated", {
				threadId: runtime.id,
				projectId,
			}));
		}
	}

	async refreshWebStatus() {
		await this.piWebStatus?.refresh();
	}

	webThread(thread) {
		if (!this.piWebStatus || !thread.path) return thread;
		const status = this.threads.has(thread.id) ? "notRunning" : this.piWebStatus.status(thread.id, thread.path);
		const previous = this.webThreads.get(thread.id);
		const row = { id: thread.id, file: thread.path, name: thread.name, preview: thread.preview, status };
		this.webThreads.delete(thread.id);
		this.webThreads.set(thread.id, row);
		if (previous && previous.status !== status) this.notifyWebStatus(row);
		// ponytail: poll only the last 500 visible/read rows; use subscriptions if
		// the UI needs a larger live catalog. Each poll is one Web list request.
		if (this.webThreads.size > 500) this.webThreads.delete(this.webThreads.keys().next().value);
		if (!this.webStatusTimer && !this.closing) {
			this.webStatusTimer = setInterval(() => {
				void this.pollWebStatus().catch(error => console.error(error.message));
			}, 2000);
			this.webStatusTimer.unref?.();
		}
		return { ...thread, name: piWebLabel(thread.name, thread.preview, status),
			status: this.starting.has(thread.id) ? thread.status : this.webRuntimeStatus(thread.id, thread.path, thread.status) };
	}

	webRuntimeStatus(id, file, fallback = { type: "idle" }) {
		if (!this.piWebStatus || this.threads.has(id)) return fallback;
		const status = this.piWebStatus.status(id, file);
		return status === "running" ? { type: "active", activeFlags: [] } : fallback;
	}

	notifyWebStatus(row) {
		this.send(jsonRpcNotification("thread/name/updated", { threadId: row.id,
			threadName: piWebLabel(row.name, row.preview, row.status) || row.preview || "未命名会话" }));
		if (!this.threads.has(row.id) && !this.starting.has(row.id)) {
			this.send(jsonRpcNotification("thread/status/changed", { threadId: row.id,
				status: this.webRuntimeStatus(row.id, row.file) }));
		}
	}

	async pollWebStatus() {
		if (this.webPolling || this.closing || !this.piWebStatus) return;
		this.webPolling = true;
		try {
			await this.refreshWebStatus();
			if (this.closing) return;
			for (const row of this.webThreads.values()) {
				const owned = this.threads.get(row.id);
				const status = owned ? "notRunning" : this.piWebStatus.status(row.id, row.file);
				if (status === row.status) continue;
				row.status = status;
				this.notifyWebStatus(row);
			}
		} finally { this.webPolling = false; }
	}

	async checkWebSession(id, file, { reading = false } = {}) {
		// Existing pi-codex runtimes own their background work. Never redirect a
		// resume/interrupt to Web or misclassify that work as an external writer.
		if (!this.piWebStatus || !file || this.threads.has(id)) return;
		if (!await fs.stat(file).then(() => true, error => {
			if (error.code === "ENOENT") return false;
			throw error;
		})) return; // An unsaved new draft has no shared history to protect.
		await this.piWebStatus.refresh({ force: !reading });
		const status = this.piWebStatus.status(id, file);
		if (status === "running") {
			this.send(jsonRpcNotification("thread/status/changed", { threadId: id,
				status: this.webRuntimeStatus(id, file) }));
		}
		if (status === "running") {
			// Reuse the pinned UI's writer-conflict read-only history path.
			throw new Error("Session already has an active writer: Pi Web 正在运行此会话。可以查看历史；请等 Web 完整结束后点击 Retry。此检测不是跨客户端锁。");
		}
	}

	async startThread(params) {
		const cwd = path.resolve(params.cwd || this.cwd);
		const sessionManager = params.ephemeral
			? this.sdk.SessionManager.inMemory(cwd)
			: this.sdk.SessionManager.create(cwd);
		const view = { id: sessionManager.getSessionId(), cwd, file: sessionManager.getSessionFile(), manager: sessionManager, params: { ...params } };
		view.projectId = await this.resolveThreadProject(view.id, cwd, params, !params.ephemeral);
		this.views.set(view.id, view);
		const response = await this.viewResponse(view, false);
		this.send(jsonRpcNotification("thread/started", { thread: response.thread }));
		return response;
	}

	async resumeThread(params) {
		const loaded = this.threads.get(params.threadId);
		if (loaded && !loaded.closing) {
			loaded.guard?.check();
			return this.resumeResponse(loaded, params);
		}
		const draft = this.views.get(params.threadId);
		const info = draft?.manager ? { id: draft.id, cwd: draft.cwd, path: draft.file } : await this.findSession(params.threadId, params.path);
		if (!info) throw new Error(`Pi session not found: ${params.threadId}`);
		await this.checkWebSession(info.id, info.path, { reading: true });
		assertSessionAvailable(info.path);
		const view = { ...draft, id: info.id, cwd: info.cwd, file: info.path, params: { ...draft?.params, ...params } };
		const response = await this.viewResponse(view, !params.excludeTurns);
		this.views.set(view.id, view);
		return { ...response, runtimeWorkspaceRoots: [view.cwd], initialTurnsPage: null,
			itemsBackwardsCursor: null, turnsBackwardsCursor: response.thread.turns.length || params.excludeTurns ? "0" : null,
			tokenUsage: null };
	}

	async viewResponse(view, includeTurns) {
		let manager = view.manager;
		if (!manager) {
			const entries = (await fs.readFile(view.file, "utf8")).split("\n").filter(Boolean).map(JSON.parse);
			const header = entries[0];
			if (header.type !== "session" || header.id !== view.id) throw new Error("Pi session identity changed");
			view.cwd = header.cwd;
			manager = this.sdk.SessionManager.inMemory(view.cwd, { id: view.id }, entries);
		}
		const context = manager.buildSessionContext();
		const savedModel = context.model ? `${context.model.provider}/${context.model.modelId}` : "";
		const settings = this.sdk.SettingsManager.create(view.cwd, this.agentDir, { projectTrusted: false });
		const collaboration = view.params.collaborationMode?.settings;
		const model = view.params.model || collaboration?.model || savedModel || (settings.getDefaultModel() ? `${settings.getDefaultProvider()}/${settings.getDefaultModel()}` : "");
		const thinkingLevel = normalizeThinking(view.params.effort ?? view.params.reasoningEffort ?? collaboration?.reasoning_effort) || context.thinkingLevel || settings.getDefaultThinkingLevel();
		const state = await this.projectStore.snapshot();
		const createdAt = timestampOf(manager.getHeader()?.timestamp);
		const updatedAt = timestampOf(manager.getEntries().at(-1)?.timestamp || manager.getHeader()?.timestamp);
		const thread = { ...blankThread({ id: view.id, cwd: view.cwd, sessionFile: view.file,
			name: manager.getSessionName(), cliVersion: this.piVersion, ephemeral: !view.file,
			projectId: view.file ? projectIdForThread(state, view.id, view.cwd) : view.projectId ?? projectIdForThread(state, view.id, view.cwd) }),
			historyMode: "paginated", preview: firstUserText(context.messages), createdAt, updatedAt,
			turns: includeTurns ? entriesToTurns(manager.getBranch(), { cwd: view.cwd }) : [] };
		const config = this.threadSettings({ model, cwd: view.cwd, thinkingLevel });
		await this.refreshWebStatus();
		return { thread: this.webThread(this.preparingThread(thread, includeTurns)), model, modelProvider: "pi", modelBackendVariant: null, reasoningEffort: config.effort,
			serviceTier: null, cwd: view.cwd, approvalPolicy: config.approvalPolicy, approvalsReviewer: config.approvalsReviewer,
			sandbox: config.sandboxPolicy, permissionProfile: config.permissionProfile,
			activePermissionProfile: config.activePermissionProfile, instructionSources: [] };
	}

	async openRuntime(requestParams) {
		const view = this.views.get(requestParams.threadId);
		const params = { ...view?.params, ...requestParams };
		const info = view?.manager ? { id: view.id, path: view.file, cwd: view.cwd } : await this.findSession(params.threadId, view?.file || params.path);
		if (!info) throw new Error(`Pi session not found: ${params.threadId}`);
		await this.disposeThread(params.threadId);
		await this.checkWebSession(params.threadId, info.path);
		if (this.closing) throw new Error("pi-codex adapter is shutting down");
		const guard = acquireSessionGuard(info.path, (message) => this.sessionConflict(params.threadId, message));
		let runtime;
		try {
			let sessionManager = view?.manager;
			if (!sessionManager) {
				const header = JSON.parse((await fs.readFile(info.path, "utf8")).split("\n", 1)[0]);
				if (header.version !== 3) throw new Error("Legacy Pi session is read-only; migrate explicitly with Pi before continuing");
				if (header.id !== params.threadId) throw new Error("Pi session identity changed");
				sessionManager = this.sdk.SessionManager.open(info.path);
			}
			if (requestParams.collaborationMode?.settings?.model && requestParams.model == null) params.model = requestParams.collaborationMode.settings.model;
			if (requestParams.collaborationMode?.settings?.reasoning_effort && requestParams.effort == null) params.effort = requestParams.collaborationMode.settings.reasoning_effort;
			runtime = await this.createRuntime({
				cwd: sessionManager.getCwd(), sessionManager, params, guard,
				sessionStartEvent: view?.sessionStartEvent || { type: "session_start", reason: view?.manager ? "startup" : "resume", previousSessionFile: view?.manager ? undefined : info.path },
			});
			this.threads.set(runtime.id, runtime);
			runtime.view = view;
			const state = await this.projectStore.snapshot();
			runtime.projectId = view && !view.file ? view.projectId : projectIdForThread(state, runtime.id, runtime.cwd);
			runtime.projectAssignmentExplicit = Object.hasOwn(state.threadProjects, runtime.id) || Boolean(view && !view.file);
			this.views.delete(runtime.id);
			this.persistDynamicTools(runtime);
			if (this.closing) throw new Error("pi-codex adapter is shutting down");
			if (this.starting.get(params.threadId)?.cancelled) throw new Error("Pi turn start was interrupted");
			this.warn("Shared native Pi session: CLI and Pi Web do not honor Desktop's writer lease. If it is open there, finish or close it there before sending here. External changes will stop Desktop writes.", runtime.id);
			this.deferExtensionBinding(runtime);
			return runtime;
		} catch (error) {
			if (runtime) await this.disposeThread(runtime.id);
			else guard.release();
			throw error;
		}
	}

	resumeResponse(runtime, params) {
		setImmediate(() => {
			for (const [requestId, threadId] of this.resolvedRequests) {
				if (threadId === runtime.id) this.send(jsonRpcNotification("serverRequest/resolved", { requestId, threadId }));
			}
		});
		return {
			...this.threadResponse(runtime, !params.excludeTurns),
			runtimeWorkspaceRoots: [runtime.cwd],
			initialTurnsPage: null,
			// The native paginated-resume path fetches history after this reply.
			itemsBackwardsCursor: null,
			turnsBackwardsCursor: this.starting.has(runtime.id) || this.historyTurns(runtime).length ? "0" : null,
			tokenUsage: this.tokenUsage(runtime),
		};
	}

	async forkThread(params) {
		const owner = this.threads.get(params.threadId);
		const draft = this.views.get(params.threadId);
		const source = owner ? { id: owner.id, path: owner.session.sessionFile }
			: draft ? { id: draft.id, path: draft.file } : await this.findSession(params.threadId, params.path);
		if (!source) throw new Error(`Pi session not found: ${params.threadId}`);
		await this.checkWebSession(params.threadId, source.path);
		const guard = owner?.guard || acquireSessionGuard(source.path);
		let header, entries;
		try {
			guard.check();
			if (owner?.closing || (owner && !owner.session.isIdle) || owner?.activeTurnId ||
				this.starting.has(params.threadId) || this.opening.has(params.threadId) || this.executing.has(params.threadId)) {
				throw new Error("Cannot fork an active Pi session");
			}
			const manager = owner?.session.sessionManager || draft?.manager;
			const snapshot = manager ? [manager.getHeader(), ...manager.getEntries()]
				: (await fs.readFile(source.path, "utf8")).split("\n").filter(Boolean).map(JSON.parse);
			guard.check();
			header = snapshot[0];
			if (header.type !== "session" || header.id !== params.threadId) throw new Error("Pi session identity changed");
			if (header.version !== 3) throw new Error("Legacy Pi session cannot be forked until explicitly migrated in Pi");
			entries = this.sdk.SessionManager.inMemory(header.cwd, undefined, snapshot).getBranch();
			if (params.lastTurnId != null) {
				const turns = entriesToTurns(entries, { cwd: header.cwd });
				const index = turns.findIndex(turn => turn.id === params.lastTurnId);
				if (index < 0) throw new Error(`Turn not found: ${params.lastTurnId}`);
				if (index + 1 < turns.length) {
					const next = turnEntry(entries, turns[index + 1]);
					if (!next) throw new Error("Cannot locate Pi fork boundary");
					entries = entries.slice(0, entries.indexOf(next));
				}
			}
			entries = structuredClone(entries);
		} finally { if (!owner) guard.release(); }
		const cwd = path.resolve(header.cwd);
		const target = params.ephemeral ? this.sdk.SessionManager.inMemory(cwd) : this.sdk.SessionManager.create(cwd);
		const file = target.getSessionFile();
		const forkHeader = { ...target.getHeader(), parentSession: source.path };
		const sessionManager = this.sdk.SessionManager.inMemory(cwd, undefined, [forkHeader, ...entries]);
		if (params.name) sessionManager.appendSessionInfo(params.name);
		if (file) await fs.writeFile(file, [forkHeader, ...sessionManager.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n", { flag: "wx", mode: 0o600 });
		const state = await this.projectStore.snapshot();
		const view = { id: sessionManager.getSessionId(), cwd, file, manager: file ? undefined : sessionManager,
			params: { ...params, threadId: sessionManager.getSessionId(), path: file, cwd },
			projectId: projectIdForThread(state, source.id, header.cwd),
			sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile: source.path } };
		if (file) await this.projectStore.assignThread(view.id, view.projectId);
		this.views.set(view.id, view);
		const response = await this.viewResponse(view, !params.excludeTurns);
		this.send(jsonRpcNotification("thread/started", { thread: response.thread }));
		return { ...response, tokenUsage: null };
	}

	async injectItems(params) {
		// Only the Desktop's text user-context contract is supported. Never silently
		// discard tools, images, assistant output, or privileged message roles.
		if (!Array.isArray(params.items) || !params.items.length) throw new Error("Expected non-empty injected messages");
		const content = params.items.flatMap(item => {
			if (item?.type !== "message" || item.role !== "user" || !Array.isArray(item.content) || !item.content.length) {
				throw new Error("Pi injection supports only user text messages");
			}
			return item.content.map(block => {
				if (block?.type !== "input_text" || typeof block.text !== "string") throw new Error("Pi injection supports only input_text content");
				return { type: "text", text: block.text };
			});
		});
		return this.withExecution(params.threadId, async () => {
			let runtime = this.threads.get(params.threadId);
			if (runtime?.disposing) { await runtime.disposing; runtime = this.threads.get(params.threadId); }
			if (this.starting.has(params.threadId) || this.opening.has(params.threadId) || runtime?.closing ||
				runtime?.activeTurnId || (runtime && !runtime.session.isIdle)) throw new Error("Cannot inject into an active Pi session");
			if (runtime) {
				runtime.guard?.check();
				await runtime.session.sendCustomMessage({ customType: "codex-app-pi.injected-context", content, display: false }, { triggerTurn: false });
			} else {
				if (!this.views.has(params.threadId)) await this.resumeThread({ threadId: params.threadId });
				const view = this.views.get(params.threadId);
				await this.checkWebSession(view.id, view.file);
				const guard = acquireSessionGuard(view.file);
				try {
					if (!view.manager) {
						const header = JSON.parse((await fs.readFile(view.file, "utf8")).split("\n", 1)[0]);
						if (header.version !== 3 || header.id !== view.id) throw new Error("Pi session is read-only or its identity changed");
					}
					guard.check();
					const manager = view.manager || this.sdk.SessionManager.open(view.file);
					manager.appendCustomMessageEntry("codex-app-pi.injected-context", content, false);
				} finally { guard.release(); }
			}
			return {};
		});
	}

	async readThread(params) {
		const runtime = this.threads.get(params.threadId);
		if (runtime) return { thread: this.threadObject(runtime, Boolean(params.includeTurns)) };
		const view = this.views.get(params.threadId);
		if (view?.manager) return { thread: (await this.viewResponse(view, Boolean(params.includeTurns))).thread };
		const info = await this.findSession(params.threadId, view?.file);
		if (!info) throw new Error(`Pi session not found: ${params.threadId}`);
		const entries = (await fs.readFile(info.path, "utf8")).split("\n").filter(Boolean).map(JSON.parse);
		const manager = this.sdk.SessionManager.inMemory(info.cwd || entries[0]?.cwd, { id: info.id }, entries);
		const state = await this.projectStore.snapshot();
		await this.refreshWebStatus();
		return {
			thread: this.webThread(this.preparingThread({
				...threadFromSessionInfo(
					info,
					this.piVersion,
					[],
					projectIdForThread(state, info.id, info.cwd),
				),
				// Reuse Codex's paginated read-only hydration on writer conflicts.
				historyMode: "paginated",
				turns: params.includeTurns ? entriesToTurns(manager.getBranch(), { cwd: info.cwd }) : [],
			}, Boolean(params.includeTurns))),
		};
	}

	async listThreads(params) {
		// No native Pi section/topology mapping exists. A filtered catalog must
		// not masquerade as all sessions (Codex uses sectionId for pinned rows).
		if (params.sectionId != null || params.parentThreadId != null || params.ancestorThreadId != null ||
			(Array.isArray(params.sourceKinds) && params.sourceKinds.length && !params.sourceKinds.includes("appServer"))) {
			return { data: [], nextCursor: null, backwardsCursor: null };
		}
		const [all, projectState] = await Promise.all([
			this.sdk.SessionManager.listAll(),
			this.projectStore.snapshot(),
			this.refreshWebStatus(),
		]);
		const search = typeof params.searchTerm === "string" ? params.searchTerm.toLowerCase() : "";
		const cwdFilter = normalizeCwdFilter(params.cwd);
		let rows = all.filter((info) =>
			(projectState.archivedThreads || []).includes(info.id) === (params.archived === true) &&
			(!search || `${info.name || ""} ${info.firstMessage}`.toLowerCase().includes(search)),
		);
		if (cwdFilter.length) rows = rows.filter((info) => cwdFilter.includes(info.cwd));
		if (Object.hasOwn(params, "projectId") && params.projectId !== undefined) {
			const projectId = normalizeProjectId(params.projectId);
			rows = rows.filter(
				(info) => projectIdForThread(projectState, info.id, info.cwd) === projectId,
			);
		}
		rows.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
		const limit = Math.max(1, Number(params.limit) || 50);
		const start = Math.max(0, Number(params.cursor) || 0);
		const page = rows.slice(start, start + limit);
		return {
			data: page.map((info) => {
				const loaded = this.threads.get(info.id);
				return loaded
					? this.threadObject(loaded, false)
					: this.webThread(threadFromSessionInfo(
							info,
							this.piVersion,
							[],
							projectIdForThread(projectState, info.id, info.cwd),
						));
			}),
			nextCursor: start + limit < rows.length ? String(start + limit) : null,
			backwardsCursor: start > 0 ? String(Math.max(0, start - limit)) : null,
		};
	}

	async listLoadedThreads() {
		return {
			data: [...[...this.threads.values()].map((runtime) => this.threadObject(runtime, false)),
				...await Promise.all([...this.views.values()].filter(view => !this.threads.has(view.id)).map(async view => (await this.viewResponse(view, false)).thread))],
		};
	}

	async setThreadName(params) {
		const runtime = this.threads.get(params.threadId);
		if (runtime) {
			runtime.guard?.check();
			if (runtime.closing) throw new Error("Pi thread is closing");
			runtime.session.setSessionName(params.name);
			runtime.name = params.name;
		} else {
			if (!this.views.has(params.threadId)) await this.resumeThread({ threadId: params.threadId });
			const view = this.views.get(params.threadId);
			await this.checkWebSession(view.id, view.file);
			const guard = acquireSessionGuard(view.file);
			try {
				if (!view.manager) {
					const header = JSON.parse((await fs.readFile(view.file, "utf8")).split("\n", 1)[0]);
					if (header.version !== 3 || header.id !== view.id) throw new Error("Pi session is read-only or its identity changed");
				}
				guard.check();
				const manager = view.manager || this.sdk.SessionManager.open(view.file);
				manager.appendSessionInfo(params.name);
			} finally { guard.release(); }
		}
		const tracked = this.webThreads.get(params.threadId);
		if (tracked) tracked.name = params.name;
		this.send(jsonRpcNotification("thread/name/updated", {
			threadId: params.threadId,
			threadName: params.name,
		}));
		return {};
	}

	async updateThreadMetadata(params) {
		const hasProjectId = Object.hasOwn(params, "projectId") && params.projectId !== undefined;
		if (hasProjectId) {
			const projectId = normalizeProjectId(params.projectId);
			const runtime = this.threads.get(params.threadId);
			const view = this.views.get(params.threadId);
			if (runtime ? runtime.session.sessionFile : !view || view.file) {
				await this.projectStore.assignThread(params.threadId, projectId);
			} else {
				const state = await this.projectStore.snapshot();
				if (projectId && !state.projects.some((project) => project.id === projectId)) {
					throw new Error(`Project not found: ${projectId}`);
				}
			}
			if (view) view.projectId = projectId;
			if (runtime) {
				runtime.projectId = projectId;
				runtime.projectAssignmentExplicit = true;
			}
			this.send(jsonRpcNotification("thread/project/updated", {
				threadId: params.threadId,
				projectId,
			}));
		}
		const runtime = this.threads.get(params.threadId);
		if (runtime) return { thread: this.threadObject(runtime, false) };
		const view = this.views.get(params.threadId);
		if (view) return { thread: (await this.viewResponse(view, false)).thread };
		const info = await this.findSession(params.threadId);
		if (!info) throw new Error(`Pi session not found: ${params.threadId}`);
		const state = await this.projectStore.snapshot();
		return {
			thread: threadFromSessionInfo(
				info,
				this.piVersion,
				[],
				projectIdForThread(state, info.id, info.cwd),
			),
		};
	}

	async archiveThread(params, archived) {
		if (this.opening.has(params.threadId)) throw new Error("Pi thread is opening for writing; interrupt preparation first");
		const runtime = this.threads.get(params.threadId);
		if (!runtime && !this.views.has(params.threadId) && !(await this.findSession(params.threadId))) throw new Error(`Pi session not found: ${params.threadId}`);
		if (archived && runtime) await this.disposeThread(runtime.id);
		await this.projectStore.setArchived(params.threadId, archived);
		if (runtime) runtime.archived = archived;
		if (archived) this.views.delete(params.threadId);
		this.send(jsonRpcNotification(archived ? "thread/archived" : "thread/unarchived", {
			threadId: params.threadId,
		}));
		return {};
	}

	async deleteThread(params) {
		if (this.opening.has(params.threadId)) throw new Error("Pi thread is opening for writing; interrupt preparation first");
		const runtime = this.threads.get(params.threadId);
		const view = this.views.get(params.threadId);
		const info = runtime ? { path: runtime.session.sessionFile } : view ? { path: view.file } : await this.findSession(params.threadId);
		await this.checkWebSession(params.threadId, info?.path);
		const guard = runtime?.guard || acquireSessionGuard(info?.path);
		try {
			guard.check();
			// Keep ownership until the file removal is complete.
			if (runtime) runtime.guard = null;
			await this.disposeThread(params.threadId);
			guard.check();
			if (info?.path) await fs.rm(info.path, { force: true });
		} finally { guard.release(); }
		await this.projectStore.removeThread(params.threadId);
		this.views.delete(params.threadId);
		this.webThreads.delete(params.threadId);
		this.send(jsonRpcNotification("thread/deleted", { threadId: params.threadId }));
		return {};
	}

	async updateThreadSettings(params) {
		const runtime = this.threads.get(params.threadId);
		if (!runtime) {
			if (!this.views.has(params.threadId)) await this.resumeThread({ threadId: params.threadId });
			const view = this.views.get(params.threadId);
			const { model, modelProvider, effort, reasoningEffort, collaborationMode } = params;
			for (const [key, value] of Object.entries({ model, modelProvider, effort, reasoningEffort, collaborationMode })) {
				if (value !== undefined) view.params[key] = value;
			}
			const response = await this.viewResponse(view, false);
			this.send(jsonRpcNotification("thread/settings/updated", { threadId: view.id,
				threadSettings: this.threadSettings({ model: response.model, cwd: view.cwd, thinkingLevel: normalizeThinking(response.reasoningEffort) }) }));
			return {};
		}
		return this.withExecution(params.threadId, async () => {
			runtime.guard?.check();
			if (runtime.closing) throw new Error("Pi thread is closing");
			await this.applyModelSettings(runtime, params);
			this.send(jsonRpcNotification("thread/settings/updated", {
				threadId: runtime.id,
				threadSettings: this.threadSettings(runtime),
			}));
			return {};
		});
	}

	async contextUsage(params) {
		const runtime = this.threads.get(params.threadId);
		if (!runtime) {
			if (!this.views.has(params.threadId) && !await this.findSession(params.threadId)) throw new Error(`Pi session not found: ${params.threadId}`);
			return { contextWindowUsage: null };
		}
		const stats = runtime.session.getSessionStats();
		const usage = stats.contextUsage;
		return {
			contextWindowUsage: usage
				? {
					calibrated: true,
					source: "traeChatGateway",
					categories: [{ kind: "otherMessages", tokens: usage.tokens || 0 }],
				}
				: null,
		};
	}

	async compactThread(params) {
		return this.withExecution(params.threadId, async () => {
			const runtime = await this.requireThread(params.threadId);
			await runtime.session.compact(params.userGuidance || undefined);
			const entry = runtime.session.sessionManager.getBranch().findLast(e => e.type === "compaction");
			if (!entry) throw new Error("Pi compaction completed without a saved entry");
			const item = { type: "contextCompaction", id: entry.id };
			const turn = { ...newTurn(), id: `turn-${entry.id}`, items: [item], status: "completed", completedAt: nowSeconds() };
			// Persist UI identity only after success; cancelled compaction writes nothing.
			runtime.session.sessionManager.appendCustomEntry("codex-app-pi.compaction-turn", { entryId: entry.id, turn });
			this.send(jsonRpcNotification("item/started", { threadId: runtime.id, turnId: turn.id, item, startedAtMs: nowMilliseconds() }));
			this.send(jsonRpcNotification("item/completed", { threadId: runtime.id, turnId: turn.id, item, completedAtMs: nowMilliseconds() }));
			this.send(jsonRpcNotification("turn/completed", { threadId: runtime.id, turn }));
			return {};
		});
	}

	async revertThread(params) {
		return this.withExecution(params.threadId, async () => {
			const runtime = await this.requireThread(params.threadId);
			const turns = entriesToTurns(runtime.session.sessionManager.getBranch(), { cwd: runtime.cwd });
			const index = turns.findIndex((turn) => turn.id === params.beforeTurnId);
			if (index < 0) throw new Error(`Turn not found: ${params.beforeTurnId}`);
			await this.dropTurns(runtime, turns.length - index);
			return { thread: this.threadObject(runtime, true) };
		});
	}

	async rollbackThread(params) {
		return this.withExecution(params.threadId, async () => {
			const runtime = await this.requireThread(params.threadId);
			const count = Math.max(1, Number(params.numTurns) || 1);
			await this.dropTurns(runtime, count);
			return { thread: this.threadObject(runtime, true) };
		});
	}

	async dropTurns(runtime, count) {
		if (!runtime.session.isIdle) throw new Error("Cannot revert an active Pi session");
		const branch = runtime.session.sessionManager.getBranch();
		const turn = entriesToTurns(branch, { cwd: runtime.cwd }).at(-count);
		const target = turn && turnEntry(branch, turn);
		if (!target) throw new Error(`Cannot drop ${count} turn(s) from this Pi session`);
		if (target.parentId) {
			const result = await runtime.session.navigateTree(target.parentId, { summarize: false });
			if (result.cancelled) throw new Error("Pi rollback was cancelled by an extension");
		} else {
			runtime.session.sessionManager.resetLeaf();
			runtime.session.agent.state.messages = [];
		}
		// SDK navigation changes only the in-memory leaf. An append at that leaf
		// makes the selection durable without deleting history or adding context.
		runtime.session.sessionManager.appendCustomEntry("codex-app-pi.branch-selection", {});
	}

	historyTurns(runtime) {
		const turns = entriesToTurns(runtime.session.sessionManager.getBranch(), { cwd: runtime.cwd });
		if (runtime.activeTurnId) {
			let active = turns.find((turn) => turn.id === runtime.activeTurnId);
			if (!active) {
				active = { id: runtime.activeTurnId, items: [], itemsView: "full", startedAt: Math.floor(runtime.turnStartedAt / 1000) };
				turns.push(active);
			}
			Object.assign(active, { status: "inProgress", error: null, completedAt: null, durationMs: null });
			// Native JSONL has only completed messages; include the current stream.
			for (const item of runtime.currentItems) {
				const index = active.items.findIndex((saved) => saved.id === item.id);
				if (index < 0) active.items.push(structuredClone(item));
				else active.items[index] = structuredClone(item);
			}
		}
		return turns;
	}

	async listTurns(params) {
		const { thread } = await this.readThread({ threadId: params.threadId, includeTurns: true });
		const page = historyPage(thread.turns, params);
		if (params.itemsView === "notLoaded") {
			page.data = page.data.map(turn => ({ ...turn, items: [], itemsView: "notLoaded" }));
		}
		return page;
	}

	async listItems(params) {
		const { thread } = await this.readThread({ threadId: params.threadId, includeTurns: true });
		const turn = thread.turns.find((candidate) => candidate.id === params.turnId);
		return historyPage((turn?.items || []).map(item => ({ turnId: params.turnId, item })), params);
	}

	preparingThread(thread, includeTurns) {
		const turn = this.starting.get(thread.id)?.turn;
		if (!turn) return thread;
		thread.status = { type: "active", activeFlags: [] };
		if (includeTurns && !thread.turns.some(saved => saved.id === turn.id)) thread.turns.push(structuredClone(turn));
		return thread;
	}

	async startTurn(params) {
		if (this.starting.has(params.threadId)) throw new Error("Pi thread is already preparing a turn");
		if (this.threads.get(params.threadId)?.activeTurnId) throw new Error("Pi thread already has an active turn");
		const parsed = inputToPiSafe(params.input);
		const starting = { cancelled: false, turn: newTurn(), startedAtMs: nowMilliseconds() };
		this.starting.set(params.threadId, starting);
		// The pinned UI can interrupt a pending start only after learning its ID.
		// This notification is a preparation identity, not successful admission.
		this.send(jsonRpcNotification("turn/started", { threadId: params.threadId, turn: starting.turn }));
		this.send(jsonRpcNotification("thread/status/changed", { threadId: params.threadId, status: { type: "active", activeFlags: [] } }));
		let runtime;
		try {
			runtime = await this.requireThread(params.threadId, params);
			if (starting.cancelled) throw new Error("Pi turn start was interrupted");
			if (runtime.closing || this.closing) throw new Error("Pi thread is closing");
			if (runtime.activeTurnId) throw new Error("Pi thread already has an active turn");
			await this.applyModelSettings(runtime, params);
			if (starting.cancelled) throw new Error("Pi turn start was interrupted");
		} catch (error) {
			if (runtime && !runtime.activeTurnId) await this.disposeThread(params.threadId);
			const file = this.webThreads.get(params.threadId)?.file || this.views.get(params.threadId)?.file || params.path;
			// No prompt was submitted: settle the provisional UI turn without
			// appending input/model context or touching a competing writer's JSONL.
			this.send(jsonRpcNotification("turn/completed", { threadId: params.threadId, turn: {
				...starting.turn, status: starting.cancelled ? "interrupted" : "failed",
				error: starting.cancelled ? null : { message: error instanceof Error ? error.message : String(error) },
				completedAt: nowSeconds(), durationMs: nowMilliseconds() - starting.startedAtMs,
			} }));
			this.send(jsonRpcNotification("thread/status/changed", { threadId: params.threadId,
				status: this.webRuntimeStatus(params.threadId, file) }));
			throw error;
		} finally { this.starting.delete(params.threadId); }
		const turn = this.beginTurn(runtime, starting.turn, false);
		runtime.pendingInput = normalizeCodexInput(params.input);
		void runtime.session
			.prompt(parsed.text, { images: parsed.images, source: "rpc" })
			.then(() => {
				if (runtime.activeTurnId === turn.id && runtime.session.isIdle) this.completeTurn(runtime);
			})
			.catch((error) => {
				if (runtime.activeTurnId === turn.id) this.failTurn(runtime, error);
			});
		return { turn };
	}

	beginTurn(runtime, turn = newTurn(), notify = true) {
		runtime.activeTurnId = turn.id;
		runtime.stopRequested = false;
		runtime.persistedTurnId = null;
		runtime.turnStartedAt = nowMilliseconds();
		runtime.currentItems = [];
		runtime.userItemId = null;
		runtime.assistantItemId = null;
		runtime.reasoningItemId = null;
		runtime.lastAssistant = null;
		runtime.pendingInput = null;
		if (notify) {
			this.send(jsonRpcNotification("turn/started", { threadId: runtime.id, turn }));
			this.send(jsonRpcNotification("thread/status/changed", { threadId: runtime.id, status: { type: "active", activeFlags: [] } }));
		}
		return turn;
	}

	persistTurn(runtime) {
		if (runtime.persistedTurnId === runtime.activeTurnId) return;
		runtime.session.sessionManager?.appendCustomEntry("codex-app-pi.turn", {
			id: runtime.activeTurnId, status: "interrupted",
			startedAt: Math.floor(runtime.turnStartedAt / 1000),
		});
		runtime.persistedTurnId = runtime.activeTurnId;
	}

	async steerTurn(params) {
		const runtime = this.threads.get(params.threadId);
		if (!runtime) throw new Error(`Pi thread is not loaded: ${params.threadId}`);
		runtime.guard?.check();
		if (runtime.activeTurnId !== params.expectedTurnId) throw new Error("Active turn does not match expectedTurnId");
		const parsed = inputToPiSafe(params.input);
		await runtime.session.steer(parsed.text, parsed.images);
		return {};
	}

	async interruptTurn(params) {
		const runtime = this.threads.get(params.threadId);
		const starting = this.starting.get(params.threadId);
		if (starting) {
			if (params.turnId && starting.turn.id !== params.turnId) throw new Error("Active turn does not match turnId");
			starting.cancelled = true;
			this.cancelRequests(params.threadId);
			runtime?.session.clearQueue();
			await runtime?.session.abort();
			return {};
		}
		if (!runtime) throw new Error(`Pi thread is not loaded: ${params.threadId}`);
		if (params.turnId && runtime.activeTurnId !== params.turnId) throw new Error("Active turn does not match turnId");
		if (runtime.activeTurnId) runtime.stopRequested = true;
		this.cancelRequests(runtime.id);
		runtime.session.clearQueue();
		await runtime.session.abort();
		return {};
	}

	async ensureCatalogServices() {
		if (!this.catalogServices) this.catalogServices = await this.createServices(this.cwd);
		return this.catalogServices;
	}

	async createServices(cwd) {
		const saved = this.trustStore.get(cwd);
		const override = process.env.PI_DESKTOP_PROJECT_TRUST;
		const projectTrusted = override === "always" || (override !== "never" && saved === true);
		const settingsManager = this.sdk.SettingsManager.create(cwd, this.agentDir, { projectTrusted });
		return this.sdk.createAgentSessionServices({
			cwd,
			agentDir: this.agentDir,
			settingsManager,
			resourceLoaderOptions: {
				eventBus: this.sdk.createEventBus(),
				extensionFactories: this.inlineExtensions,
			},
		});
	}

	async createRuntime({ cwd, sessionManager, params, sessionStartEvent, guard }) {
		const ownsGuard = !guard;
		guard ||= acquireSessionGuard(sessionManager.getSessionFile(), (message) => this.sessionConflict(sessionManager.getSessionId(), message));
		try {
		guard.bind(sessionManager);
		const requestedDynamicTools = flattenDynamicTools(params.dynamicTools);
		const storedDynamicTools = [...sessionManager.getEntries()]
			.reverse()
			.find((entry) => entry.type === "custom" && entry.customType === "codex-app-pi.dynamic-tools")
			?.data?.tools;
		const dynamicTools = requestedDynamicTools.length
			? requestedDynamicTools
			: flattenDynamicTools(storedDynamicTools);
		const threadId = sessionManager.getSessionId();
		const customTools = dynamicTools.map((spec) => this.makeDesktopTool(spec, threadId));
		const services = await this.createServices(cwd);
		const modelId = params.model ?? params.collaborationMode?.settings?.model;
		const selectedModel = this.resolveModel(services, modelId, params.modelProvider);
		if (modelId && !selectedModel) throw new Error(`Pi model not available: ${modelId}`);
		const thinkingLevel = normalizeThinking(params.effort ?? params.reasoningEffort ?? params.collaborationMode?.settings?.reasoning_effort);
		const created = await this.sdk.createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			model: selectedModel,
			thinkingLevel,
			customTools,
		});
		const runtime = {
			id: created.session.sessionId,
			guard,
			cwd,
			name: created.session.sessionName,
			session: created.session,
			services,
			lifecycle: new this.sdk.AgentSessionRuntime(
				created.session,
				services,
				async () => {
					throw new Error("pi-codex owns session replacement");
				},
				services.diagnostics,
				created.modelFallbackMessage,
			),
			dynamicTools,
			createdAt: nowSeconds(),
			updatedAt: nowSeconds(),
			activeTurnId: null,
			turnStartedAt: null,
			currentItems: [],
			activeTools: new Map(),
			toolOutput: new Map(),
			archived: false,
			projectId: null,
			projectAssignmentExplicit: false,
			unsubscribe: null,
		};
		runtime.unsubscribe = created.session.subscribe((event) => this.onPiEvent(runtime, event));
		runtime.model = created.session.model ? piModelId(created.session.model) : "";
		runtime.provider = created.session.model?.provider || "pi";
		runtime.ready = null;
		return runtime;
		} catch (error) { if (ownsGuard) guard.release(); throw error; }
	}

	persistDynamicTools(runtime) {
		if (!runtime.dynamicTools.length) return;
		runtime.session.sessionManager.appendCustomEntry("codex-app-pi.dynamic-tools", {
			version: 1,
			tools: runtime.dynamicTools,
		});
	}

	deferExtensionBinding(runtime) {
		runtime.ready = new Promise((resolve, reject) => {
			setImmediate(() => {
				if (runtime.closing || this.closing) { resolve(); return; }
				this.bindRuntimeExtensions(runtime).then(resolve, reject);
			});
		});
		// Observe startup failure immediately even when the UI never sends turn/start.
		void runtime.ready.catch((error) => this.warn(`Pi extension startup failed: ${error.message}`, runtime.id));
	}

	async bindRuntimeExtensions(runtime) {
		await runtime.session.bindExtensions({
			uiContext: this.extensionUi(runtime),
			mode: "rpc",
			commandContextActions: {
				waitForIdle: () => runtime.session.waitForIdle(),
				newSession: async () => {
					throw new Error("Create a new conversation from ChatGPT Desktop");
				},
				fork: async (entryId, options) => {
					const result = await runtime.session.navigateTree(entryId, {
						summarize: false,
						label: options?.position,
					});
					return { cancelled: result.cancelled };
				},
				navigateTree: (targetId, options) => runtime.session.navigateTree(targetId, options),
				switchSession: async () => {
					throw new Error("Switch sessions from ChatGPT Desktop");
				},
				reload: () => runtime.session.reload(),
			},
			abortHandler: () => runtime.session.abort(),
			onError: (error) =>
				this.warn(`Pi extension error in ${error.extensionPath}: ${error.error}`, runtime.id),
		});
		if (
			!runtime.services.settingsManager.isProjectTrusted() &&
			this.sdk.hasTrustRequiringProjectResources(runtime.cwd)
		) {
			this.warn(
				`Pi did not load untrusted project extensions/settings in ${runtime.cwd}. Trust it once with \`pi --approve\` or set PI_DESKTOP_PROJECT_TRUST=always.`,
				runtime.id,
			);
		}
	}

	resolveModel(services, modelId, providerId) {
		const models = services.modelRuntime.getAvailableSnapshot();
		if (!modelId) return undefined;
		if (providerId && providerId !== "pi") {
			const direct = models.find((model) => model.provider === providerId && model.id === modelId);
			if (direct) return direct;
		}
		const slash = modelId.indexOf("/");
		if (slash > 0) {
			const provider = modelId.slice(0, slash);
			const id = modelId.slice(slash + 1);
			return models.find((model) => model.provider === provider && model.id === id);
		}
		return models.find((model) => model.id === modelId);
	}

	async applyModelSettings(runtime, params) {
		const collaboration = params.collaborationMode?.settings;
		const modelId = params.model ?? collaboration?.model;
		const selected = this.resolveModel(runtime.services, modelId, params.modelProvider);
		if (modelId && !selected) throw new Error(`Pi model not available: ${modelId}`);
		if (selected && (!runtime.session.model || piModelId(runtime.session.model) !== piModelId(selected))) {
			await runtime.session.setModel(selected);
		}
		const effort = normalizeThinking(params.effort ?? params.reasoningEffort ?? collaboration?.reasoning_effort);
		if (effort) runtime.session.setThinkingLevel(effort);
		runtime.model = runtime.session.model ? piModelId(runtime.session.model) : "";
		runtime.provider = runtime.session.model?.provider || "pi";
	}

	makeDesktopTool(spec, threadId) {
		return this.sdk.defineTool({
			name: spec.name,
			label: spec.name,
			description: spec.description,
			parameters: this.sdk.Type.Unsafe(spec.inputSchema),
			execute: async (toolCallId, args, signal) => {
				const runtime = this.threads.get(threadId);
				if (!runtime || this.disconnected || this.clientDetached || runtime.closing || !runtime.activeTurnId) throw new Error("Desktop tool has no active Pi turn");
				if (signal?.aborted) throw signal.reason || new Error("Desktop tool aborted");
				const requestId = newId("desktop-tool");
				const promise = new Promise((resolve, reject) => {
					const finish = (message) => {
						if (!this.dynamicCalls.delete(requestId)) return;
						signal?.removeEventListener("abort", onAbort);
						if (message.error) { reject(new Error(message.error.message || "Desktop tool failed")); return; }
						const result = codexResultToPi(message.result);
						if (result.isError) reject(new Error(contentText(result.content) || "Desktop tool failed"));
						else resolve(result);
					};
					const onAbort = () => finish({ error: { message: "Desktop tool cancelled" } });
					this.dynamicCalls.set(requestId, { threadId, finish, cancel: onAbort });
					signal?.addEventListener("abort", onAbort, { once: true });
				});
				this.send({
					jsonrpc: "2.0",
					id: requestId,
					method: "item/tool/call",
					params: {
						threadId: runtime.id,
						turnId: runtime.activeTurnId,
						callId: toolCallId,
						namespace: spec.namespace,
						tool: spec.name,
						arguments: args,
					},
				});
				return promise;
			},
		});
	}

	extensionUi(runtime) {
		return {
			select: (title, options, opts) => this.askSelect(title, options, runtime, opts),
			confirm: (title, message, opts) => this.askConfirm(title, message, runtime, opts),
			input: (title, placeholder, opts) => this.askInput(title, placeholder, runtime, opts),
			editor: (title, prefill) => this.askInput(title, prefill, runtime),
			notify: (message, type = "info") => this.warn(`${type}: ${message}`, runtime.id, 5000),
			setStatus: () => {},
			setWidget: () => {},
			setTitle: () => {},
			setEditorText: (text) => {
				if (text) this.warn(`Pi extension suggested editor text:\n${text}`, runtime.id);
			},
			pasteToEditor: (text) => {
				if (text) this.warn(`Pi extension suggested editor text:\n${text}`, runtime.id);
			},
			getEditorText: () => "",
			onTerminalInput: () => () => {},
			setWorkingMessage: () => {},
			setWorkingVisible: () => {},
			setWorkingIndicator: () => {},
			setHiddenThinkingLabel: () => {},
			setFooter: () => {},
			setHeader: () => {},
			custom: async () => undefined,
			addAutocompleteProvider: () => {},
			setEditorComponent: () => {},
			getEditorComponent: () => undefined,
			theme: undefined,
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: false, error: "Theme switching is owned by ChatGPT Desktop" }),
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
		};
	}

	askSelect(title, options, runtime = null, opts = undefined) {
		const questionId = "choice";
		return this.askUser(runtime, {
			header: shortHeader(title),
			id: questionId,
			question: title,
			options: options.map((label) => ({ label, description: "" })),
			multiSelect: false,
			isOther: false,
			isSecret: false,
		}, opts, {}).then((answers) => answers[questionId]?.answers?.[0]);
	}

	askConfirm(title, message, runtime, opts = undefined) {
		return this.askSelect(`${title}\n${message}`, ["Yes", "No"], runtime, opts).then((value) => value === "Yes");
	}

	askInput(title, placeholder, runtime, opts = undefined) {
		const questionId = "value";
		return this.askUser(runtime, {
			header: shortHeader(title),
			id: questionId,
			question: placeholder ? `${title}\n${placeholder}` : title,
			options: null,
			multiSelect: false,
			isOther: true,
			isSecret: false,
		}, opts, {}).then((answers) => answers[questionId]?.answers?.[0]);
	}

	askUser(runtime, question, opts, fallback) {
		if (this.closing || this.disconnected || this.clientDetached || runtime?.closing || opts?.signal?.aborted) return Promise.resolve(fallback);
		const requestId = newId("pi-ui");
		const threadId = runtime?.id || "startup";
		const turnId = runtime?.activeTurnId || "startup";
		return new Promise((resolve) => {
			let timeout;
			const finish = (value) => {
				if (!this.uiRequests.delete(requestId)) return;
				if (timeout) clearTimeout(timeout);
				opts?.signal?.removeEventListener("abort", onAbort);
				this.resolvedRequests.set(requestId, threadId);
				if (this.resolvedRequests.size > 256) this.resolvedRequests.delete(this.resolvedRequests.keys().next().value);
				this.send(jsonRpcNotification("serverRequest/resolved", { requestId, threadId }));
				resolve(value);
			};
			const onAbort = () => finish(fallback);
			opts?.signal?.addEventListener("abort", onAbort, { once: true });
			if (opts?.timeout) timeout = setTimeout(onAbort, opts.timeout);
			this.uiRequests.set(requestId, {
				threadId,
				finish: (message) => finish(message.result?.answers || fallback),
				cancel: onAbort,
			});
			const message = {
				jsonrpc: "2.0",
				id: requestId,
				method: "item/tool/requestUserInput",
				params: {
					threadId,
					turnId,
					itemId: requestId,
					questions: [question],
					isBlocking: true,
				},
			};
			this.send(message);
		});
	}

	onPiEvent(runtime, event) {
		if (runtime.closing || this.closing) return;
		runtime.updatedAt = nowSeconds();
		switch (event.type) {
			case "agent_start":
				if (!runtime.activeTurnId) this.beginTurn(runtime);
				this.persistTurn(runtime);
				break;
			case "message_update":
				this.onMessageUpdate(runtime, event);
				break;
			case "message_end":
				this.onMessageEnd(runtime, event.message);
				break;
			case "tool_execution_start":
				this.onToolStart(runtime, event);
				break;
			case "tool_execution_update":
				this.onToolUpdate(runtime, event);
				break;
			case "tool_execution_end":
				this.onToolEnd(runtime, event);
				break;
			case "compaction_end":
				if (event.result && !event.aborted && !event.errorMessage) {
					this.send(jsonRpcNotification("thread/compacted", {
						threadId: runtime.id,
						turnId: runtime.activeTurnId,
					}));
				}
				this.scheduleIdleDispose(runtime);
				break;
			case "auto_retry_start":
				this.warn(
					`Pi retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}`,
					runtime.id,
					event.delayMs,
				);
				break;
			case "extension_error":
				this.warn(`Pi extension error: ${event.error}`, runtime.id);
				break;
			case "agent_settled":
				this.completeTurn(runtime);
				break;
		}
	}

	onMessageUpdate(runtime, event) {
		if (!runtime.activeTurnId) return;
		const delta = event.assistantMessageEvent;
		if (delta.type === "text_start") this.ensureAssistantItem(runtime);
		else if (delta.type === "text_delta") {
			const id = this.ensureAssistantItem(runtime);
			runtime.currentItems.find((item) => item.id === id).text += delta.delta || "";
			this.send(jsonRpcNotification("item/agentMessage/delta", {
				threadId: runtime.id,
				turnId: runtime.activeTurnId,
				itemId: id,
				delta: delta.delta || "",
			}));
		} else if (delta.type === "thinking_start") this.ensureReasoningItem(runtime);
		else if (delta.type === "thinking_delta") {
			const id = this.ensureReasoningItem(runtime);
			const item = runtime.currentItems.find((item) => item.id === id);
			const index = delta.contentIndex || 0;
			item.content[index] = (item.content[index] || "") + (delta.delta || "");
			this.send(jsonRpcNotification("item/reasoning/textDelta", {
				threadId: runtime.id,
				turnId: runtime.activeTurnId,
				itemId: id,
				contentIndex: delta.contentIndex || 0,
				delta: delta.delta || "",
			}));
		}
	}

	onMessageEnd(runtime, message) {
		if (!runtime.activeTurnId) return;
		if (message?.role === "user" || (message?.role === "custom" && message.display)) {
			const isUser = message.role === "user";
			if (isUser) runtime.pendingInput = null;
			const id = newId(isUser ? "user" : "custom");
			const item = isUser
				? { type: "userMessage", id, content: contentToUserInput(message.content) }
				: { type: "agentMessage", id, text: contentText(message.content), phase: "commentary", memoryCitation: null };
			const persisted = !isUser && runtime.session.sessionManager.getLeafEntry();
			runtime.session.sessionManager.appendCustomEntry("codex-app-pi.item", {
				[isUser ? "user" : "custom"]: id,
				...(persisted?.type === "custom_message" && persisted.timestamp === new Date(message.timestamp).toISOString()
					? { entryId: persisted.id } : {}),
			});
			this.send(jsonRpcNotification("item/started", { threadId: runtime.id, turnId: runtime.activeTurnId, item, startedAtMs: nowMilliseconds() }));
			this.completeItem(runtime, item);
			return;
		}
		if (message?.role !== "assistant") return;
		runtime.lastAssistant = message;
		const text = [];
		const thinking = [];
		for (const block of Array.isArray(message.content) ? message.content : []) {
			if (block.type === "text") text.push(block.text || "");
			if (block.type === "thinking") thinking.push(block.thinking || "");
		}
		if (thinking.length && !runtime.reasoningItemId) this.ensureReasoningItem(runtime);
		if (text.length && !runtime.assistantItemId) this.ensureAssistantItem(runtime);
		runtime.session.sessionManager?.appendCustomEntry("codex-app-pi.item", {
			text: runtime.assistantItemId, reasoning: runtime.reasoningItemId,
			order: runtime.currentItems
				.filter((item) => item.id === runtime.assistantItemId || item.id === runtime.reasoningItemId)
				.map((item) => item.id),
		});
		if (runtime.reasoningItemId) {
			const item = {
				type: "reasoning",
				id: runtime.reasoningItemId,
				summary: [],
				content: thinking,
			};
			this.completeItem(runtime, item);
			runtime.reasoningItemId = null;
		}
		if (text.length && !runtime.assistantItemId) this.ensureAssistantItem(runtime);
		if (runtime.assistantItemId) {
			const item = {
				type: "agentMessage",
				id: runtime.assistantItemId,
				text: text.join(""),
				phase: null,
				memoryCitation: null,
			};
			this.completeItem(runtime, item);
			runtime.assistantItemId = null;
		}
		this.emitUsage(runtime, message.usage);
	}

	onToolStart(runtime, event) {
		if (!runtime.activeTurnId) return;
		const item = toolItem(runtime, event, "inProgress");
		runtime.activeTools.set(event.toolCallId, item);
		runtime.toolOutput.set(event.toolCallId, "");
		runtime.currentItems.push(item);
		this.send(jsonRpcNotification("item/started", {
			threadId: runtime.id,
			turnId: runtime.activeTurnId,
			startedAtMs: nowMilliseconds(),
			item,
		}));
	}

	onToolUpdate(runtime, event) {
		const item = runtime.activeTools.get(event.toolCallId);
		if (!item || !runtime.activeTurnId) return;
		const text = contentText(event.partialResult?.content);
		if (!text) return;
		const previous = runtime.toolOutput.get(event.toolCallId) || "";
		const delta = text.startsWith(previous) ? text.slice(previous.length) : text;
		runtime.toolOutput.set(event.toolCallId, text);
		if (!delta) return;
		if (item.type === "commandExecution") {
			item.aggregatedOutput = text;
			this.send(jsonRpcNotification("item/commandExecution/outputDelta", {
				threadId: runtime.id,
				turnId: runtime.activeTurnId,
				itemId: item.id,
				delta,
			}));
		}
	}

	onToolEnd(runtime, event) {
		const item = runtime.activeTools.get(event.toolCallId);
		if (!item) return;
		runtime.activeTools.delete(event.toolCallId);
		runtime.toolOutput.delete(event.toolCallId);
		completeToolItem(item, event.result, event.isError);
		this.completeItem(runtime, item);
	}

	ensureAssistantItem(runtime) {
		if (!runtime.assistantItemId) {
			runtime.assistantItemId = newId("agent");
			const item = {
				type: "agentMessage",
				id: runtime.assistantItemId,
				text: "",
				phase: null,
				memoryCitation: null,
			};
			runtime.currentItems.push(item);
			this.send(jsonRpcNotification("item/started", {
				threadId: runtime.id,
				turnId: runtime.activeTurnId,
				startedAtMs: nowMilliseconds(),
				item,
			}));
		}
		return runtime.assistantItemId;
	}

	ensureReasoningItem(runtime) {
		if (!runtime.reasoningItemId) {
			runtime.reasoningItemId = newId("reasoning");
			const item = { type: "reasoning", id: runtime.reasoningItemId, summary: [], content: [] };
			runtime.currentItems.push(item);
			this.send(jsonRpcNotification("item/started", {
				threadId: runtime.id,
				turnId: runtime.activeTurnId,
				startedAtMs: nowMilliseconds(),
				item,
			}));
		}
		return runtime.reasoningItemId;
	}

	completeItem(runtime, item) {
		const index = runtime.currentItems.findIndex((candidate) => candidate.id === item.id);
		if (index >= 0) runtime.currentItems[index] = item;
		else runtime.currentItems.push(item);
		this.send(jsonRpcNotification("item/completed", {
			threadId: runtime.id,
			turnId: runtime.activeTurnId,
			completedAtMs: nowMilliseconds(),
			item,
		}));
	}

	completeTurn(runtime) {
		if (!runtime.activeTurnId) return;
		const state = runtime.stopRequested ? { status: "interrupted", error: null } : terminalState(runtime.lastAssistant);
		if (runtime.persistedTurnId !== runtime.activeTurnId) this.persistTurn(runtime);
		if (runtime.pendingInput) {
			const item = { type: "userMessage", id: newId("user"), content: runtime.pendingInput };
			// Preflight failures and locally handled commands never emit a Pi user message.
			// Keep the submitted input display-only, without inventing model context.
			runtime.session.sessionManager?.appendCustomEntry("codex-app-pi.input", item);
			this.send(jsonRpcNotification("item/started", { threadId: runtime.id, turnId: runtime.activeTurnId, item, startedAtMs: nowMilliseconds() }));
			this.completeItem(runtime, item);
			runtime.pendingInput = null;
		}
		const turn = {
			id: runtime.activeTurnId,
			...state,
			items: runtime.currentItems,
			itemsView: "full",
			startedAt: Math.floor((runtime.turnStartedAt || nowMilliseconds()) / 1000),
			completedAt: nowSeconds(),
			durationMs: nowMilliseconds() - (runtime.turnStartedAt || nowMilliseconds()),
		};
		const { items, ...metadata } = turn;
		runtime.session.sessionManager?.appendCustomEntry("codex-app-pi.turn-end", metadata);
		this.cancelRequests(runtime.id);
		this.send(jsonRpcNotification("turn/completed", { threadId: runtime.id, turn }));
		runtime.activeTurnId = null;
		runtime.turnStartedAt = null;
		runtime.currentItems = [];
		runtime.activeTools.clear();
		runtime.toolOutput.clear();
		runtime.assistantItemId = null;
		runtime.reasoningItemId = null;
		this.send(jsonRpcNotification("thread/status/changed", { threadId: runtime.id, status: { type: "idle" } }));
		this.scheduleIdleDispose(runtime);
	}

	failTurn(runtime, error) {
		if (!runtime.activeTurnId || runtime.closing || this.closing) return;
		if (!runtime.stopRequested) this.send(jsonRpcNotification("error", {
			threadId: runtime.id,
			turnId: runtime.activeTurnId,
			willRetry: false,
			error: { message: error instanceof Error ? error.message : String(error) },
		}));
		runtime.lastAssistant = { stopReason: "error", errorMessage: error instanceof Error ? error.message : String(error) };
		this.completeTurn(runtime);
	}

	emitUsage(runtime, usage) {
		if (!runtime.activeTurnId || !usage) return;
		const stats = runtime.session.getSessionStats();
		this.send(jsonRpcNotification("thread/tokenUsage/updated", {
			threadId: runtime.id,
			turnId: runtime.activeTurnId,
			tokenUsage: {
				last: usageBreakdown(usage),
				total: usageBreakdown(stats.tokens),
				modelContextWindow: runtime.session.model?.contextWindow || null,
				autoCompactTokenLimit: null,
			},
			context: {
				model: runtime.session.model?.id || "",
				modelProviderId: runtime.session.model?.provider || "pi",
				modelBackendVariant: null,
			},
		}));
	}

	threadResponse(runtime, includeTurns) {
		const settings = this.threadSettings(runtime);
		return {
			thread: this.threadObject(runtime, includeTurns),
			model: settings.model,
			modelProvider: settings.modelProvider,
			modelBackendVariant: settings.modelBackendVariant,
			reasoningEffort: settings.effort,
			serviceTier: settings.serviceTier,
			cwd: settings.cwd,
			approvalPolicy: settings.approvalPolicy,
			approvalsReviewer: settings.approvalsReviewer,
			sandbox: settings.sandboxPolicy,
			permissionProfile: settings.permissionProfile,
			activePermissionProfile: settings.activePermissionProfile,
			instructionSources: runtime.services.resourceLoader.getAgentsFiles().agentsFiles.map((item) => item.path),
		};
	}

	threadSettings(runtime) {
		const thinkingLevel = runtime.session?.thinkingLevel ?? runtime.thinkingLevel;
		return {
			model: runtime.model,
			modelProvider: "pi",
			modelBackendVariant: null,
			effort: thinkingLevel === "off" ? "none" : thinkingLevel,
			serviceTier: null,
			cwd: runtime.cwd,
			approvalPolicy: "never",
			approvalsReviewer: "user",
			sandboxPolicy: { type: "dangerFullAccess" },
			permissionProfile: { type: "disabled" },
			activePermissionProfile: { id: ":danger-full-access", extends: null, modifications: [] },
			collaborationMode: {
				mode: "default",
				settings: {
					model: runtime.model,
					reasoning_effort:
						thinkingLevel === "off" ? "none" : thinkingLevel,
					developer_instructions: null,
				},
			},
			personality: null,
			summary: null,
			windowsSandboxLevel: "disabled",
		};
	}

	threadObject(runtime, includeTurns) {
		return this.webThread(this.preparingThread({
			...blankThread({
				id: runtime.id,
				cwd: runtime.cwd,
				sessionFile: runtime.session.sessionFile,
				name: runtime.session.sessionName || runtime.name,
				modelProvider: "pi",
				cliVersion: this.piVersion,
				ephemeral: !runtime.session.sessionFile,
				projectId: runtime.projectId,
			}),
			historyMode: "paginated",
			preview: firstUserText(runtime.session.messages),
			createdAt: runtime.createdAt,
			updatedAt: runtime.updatedAt,
			status: runtime.activeTurnId ? { type: "active", activeFlags: [] } : { type: "idle" },
			turns: includeTurns ? this.historyTurns(runtime) : [],
		}, includeTurns));
	}

	tokenUsage(runtime) {
		const stats = runtime.session.getSessionStats();
		return {
			last: usageBreakdown(runtime.session.messages.filter((m) => m.role === "assistant").at(-1)?.usage),
			total: usageBreakdown(stats.tokens),
			modelContextWindow: runtime.session.model?.contextWindow || null,
			autoCompactTokenLimit: null,
		};
	}

	async requireThread(threadId, params = {}) {
		if (this.opening.has(threadId)) throw new Error("Pi thread is already opening for writing");
		let runtime = this.threads.get(threadId);
		if (runtime?.disposing) {
			await runtime.disposing;
			runtime = this.threads.get(threadId);
		}
		const created = !runtime;
		if (runtime?.closing) throw new Error("Pi thread is closing");
		if (!runtime) {
			const opening = this.openRuntime({ ...params, threadId });
			this.opening.set(threadId, opening);
			try { runtime = await opening; }
			finally { this.opening.delete(threadId); }
		}
		try {
			// All executing callers (including compact/revert) need bound extensions,
			// not just an allocated AgentSession. Recheck ownership after that await.
			await runtime.ready;
			if (runtime.closing || this.closing) throw new Error("Pi thread is closing");
			runtime.guard?.check();
			return runtime;
		} catch (error) {
			if (created && !runtime.activeTurnId) await this.disposeThread(threadId);
			throw error;
		}
	}

	async withExecution(threadId, operation) {
		this.executing.set(threadId, (this.executing.get(threadId) || 0) + 1);
		try {
			return await operation();
		} finally {
			const remaining = (this.executing.get(threadId) || 1) - 1;
			if (remaining) this.executing.set(threadId, remaining);
			else this.executing.delete(threadId);
			const runtime = this.threads.get(threadId);
			if (runtime) this.scheduleIdleDispose(runtime);
		}
	}

	scheduleIdleDispose(runtime, delay = IDLE_DISPOSE_DELAY_MS) {
		if (runtime.closing || runtime.idleDisposeTimer || !runtime.session.sessionFile) return;
		runtime.idleDisposeTimer = setTimeout(() => {
			runtime.idleDisposeTimer = null;
			if (this.threads.get(runtime.id) !== runtime || runtime.closing || this.closing) return;
			const pendingRequest = [...this.uiRequests.values(), ...this.dynamicCalls.values()]
				.some(request => request.threadId === runtime.id);
			if (runtime.activeTurnId || !runtime.session.isIdle || this.starting.has(runtime.id) ||
				this.opening.has(runtime.id) || this.executing.has(runtime.id) || pendingRequest) {
				this.scheduleIdleDispose(runtime, LIVENESS_RECHECK_MS);
				return;
			}
			if (this.sessionLiveness.hasActiveProvider({ sessionId: runtime.id, sessionFile: runtime.session.sessionFile })) {
				this.scheduleIdleDispose(runtime, LIVENESS_RECHECK_MS);
				return;
			}
			void this.disposeThread(runtime.id).catch(error => console.error(error.message));
		}, delay);
		runtime.idleDisposeTimer.unref?.();
	}

	async resolveThreadProject(threadId, cwd, params, persist) {
		const state = await this.projectStore.snapshot();
		if (!Object.hasOwn(params, "projectId") || params.projectId === undefined) {
			return projectIdForThread(state, threadId, cwd);
		}
		const projectId = normalizeProjectId(params.projectId);
		if (projectId && !state.projects.some((project) => project.id === projectId)) {
			throw new Error(`Project not found: ${projectId}`);
		}
		if (persist) await this.projectStore.assignThread(threadId, projectId);
		return projectId;
	}

	async findSession(threadId, explicitPath) {
		if (explicitPath) return { id: threadId, path: explicitPath };
		const all = await this.sdk.SessionManager.listAll();
		return all.find((info) => info.id === threadId);
	}

	async disposeThread(threadId) {
		const runtime = this.threads.get(threadId);
		if (!runtime) return;
		if (runtime.disposing) return runtime.disposing;
		runtime.closing = true;
		clearTimeout(runtime.idleDisposeTimer);
		runtime.idleDisposeTimer = null;
		this.cancelRequests(threadId);
		runtime.disposing = (async () => {
			await runtime.ready?.catch(() => {});
			runtime.unsubscribe?.();
			runtime.session?.clearQueue();
			try {
				await runtime.session?.abort();
				await runtime.lifecycle.dispose();
			} finally {
				runtime.guard?.release();
				this.threads.delete(threadId);
				// Pi defers a new file until the first assistant message. Keep an
				// unsaved draft/ephemeral conversation usable after failed preparation.
				if (runtime.view?.manager && (!runtime.session.sessionFile || !await fs.stat(runtime.session.sessionFile).then(() => true, error => {
					if (error.code === "ENOENT") return false;
					throw error;
				}))) this.views.set(threadId, runtime.view);
			}
		})();
		return runtime.disposing;
	}

	sessionConflict(threadId, message) {
		this.warn(message, threadId);
		const runtime = this.threads.get(threadId);
		if (runtime) {
			runtime.closing = true;
			queueMicrotask(() => { void this.disposeThread(threadId).catch(error => console.error(error.message)); });
		}
	}

	warn(message, threadId = null, displayDurationMs = null) {
		this.send(jsonRpcNotification("warning", { message, threadId, displayDurationMs }));
	}

	cancelRequests(threadId) {
		for (const pending of [...this.uiRequests.values(), ...this.dynamicCalls.values()]) {
			if (threadId === undefined || pending.threadId === threadId) pending.cancel();
		}
	}

	async shutdown() {
		this.closing = true;
		clearInterval(this.webStatusTimer);
		this.piWebStatus?.close();
		for (const starting of this.starting.values()) starting.cancelled = true;
		this.cancelRequests();
		await Promise.allSettled(this.opening.values());
		await Promise.all([...this.threads.keys()].map((threadId) => this.disposeThread(threadId)));
		this.views.clear();
	}
}

function turnEntry(branch, turn) {
	return branch.find(entry =>
		(entry.type === "custom" && entry.customType === "codex-app-pi.turn" && entry.data?.id === turn.id) ||
		`turn-${entry.id}` === turn.id);
}

function newTurn() {
	return { id: newId("turn"), status: "inProgress", items: [], itemsView: "full",
		startedAt: nowSeconds(), completedAt: null, durationMs: null, error: null };
}

function timestampOf(value) {
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : nowSeconds();
}

function historyPage(rows, params) {
	const cursor = params.cursor == null ? 0 : Number(params.cursor);
	const limit = params.limit == null ? 100 : params.limit;
	if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1) {
		throw new Error("Invalid history cursor or limit");
	}
	const ordered = params.sortDirection === "desc" ? [...rows].reverse() : rows;
	const end = cursor + Math.min(limit, 1000);
	return { data: ordered.slice(cursor, end), nextCursor: end < rows.length ? String(end) : null, backwardsCursor: null };
}

function inputToPiSafe(input) {
	return inputToPi(
		(Array.isArray(input) ? input : []).filter(
			(item) =>
				item?.type === "text" ||
				item?.type === "localImage" ||
				item?.type === "skill" ||
				item?.type === "mention" ||
				(item?.type === "image" &&
					typeof item.url === "string" &&
					item.url.startsWith("data:")),
		),
	);
}

function normalizeThinking(value) {
	if (value === "none" || value === "off") return "off";
	return REASONING_LEVELS.has(value) ? value : undefined;
}

function normalizeCwdFilter(value) {
	if (typeof value === "string") return [path.resolve(value)];
	if (Array.isArray(value)) return value.filter((item) => typeof item === "string").map((item) => path.resolve(item));
	if (value && typeof value === "object") {
		const values = value.cwd || value.cwds || value.paths;
		return normalizeCwdFilter(values);
	}
	return [];
}

function normalizeProjectId(value) {
	return typeof value === "string" && value ? value : null;
}

function platformOs() {
	if (process.platform === "darwin") return "macos";
	if (process.platform === "win32") return "windows";
	return process.platform;
}

function shortHeader(value) {
	const first = String(value).split("\n", 1)[0].trim();
	return first.slice(0, 12) || "Pi";
}

function firstUserText(messages) {
	const first = messages.find((message) => message?.role === "user");
	return contentText(first?.content).slice(0, 500);
}

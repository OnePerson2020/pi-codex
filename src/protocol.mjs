import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const nowSeconds = () => Math.floor(Date.now() / 1000);
export const nowMilliseconds = () => Date.now();
export const newId = (prefix) => `${prefix}-${crypto.randomUUID()}`;

export function jsonRpcResult(id, result) {
	return { jsonrpc: "2.0", id, result };
}

export function jsonRpcError(id, message, code = -32000) {
	return { jsonrpc: "2.0", id, error: { code, message } };
}

export function jsonRpcNotification(method, params = {}) {
	return { jsonrpc: "2.0", method, params };
}

export function splitStrictJsonLines(onLine) {
	let buffer = "";
	return (chunk) => {
		buffer += chunk;
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			let line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (line.trim()) onLine(line);
		}
	};
}

export function flattenDynamicTools(specs) {
	const flattened = [];
	for (const spec of Array.isArray(specs) ? specs : []) {
		if (!spec || typeof spec !== "object") continue;
		const tools = spec.type === "namespace" ? spec.tools : [spec];
		for (const tool of Array.isArray(tools) ? tools : []) {
			if (!tool || typeof tool !== "object") continue;
			if (tool.type && tool.type !== "function") continue;
			if (typeof tool.name !== "string" || !tool.name.trim()) continue;
			flattened.push({
				name: tool.name,
				namespace:
					typeof tool.namespace === "string"
						? tool.namespace
						: spec.type === "namespace" && typeof spec.name === "string"
							? spec.name
							: null,
				description: typeof tool.description === "string" ? tool.description : "",
				inputSchema:
					tool.inputSchema && typeof tool.inputSchema === "object"
						? tool.inputSchema
						: { type: "object", properties: {} },
			});
		}
	}
	return flattened;
}

export function inputToPi(input) {
	let text = "";
	const images = [];
	for (const item of Array.isArray(input) ? input : []) {
		if (!item || typeof item !== "object") continue;
		if (item.type === "text" && typeof item.text === "string") {
			text += item.text;
		} else if (item.type === "localImage" && typeof item.path === "string") {
			const data = fs.readFileSync(item.path).toString("base64");
			images.push({
				type: "image",
				data,
				mimeType: mimeTypeFromPath(item.path),
			});
		} else if (item.type === "image" && typeof item.url === "string") {
			const parsed = parseDataUrl(item.url);
			if (parsed) images.push(parsed);
			else text += `\n[Image URL: ${item.url}]`;
		} else if ((item.type === "skill" || item.type === "mention") && typeof item.path === "string") {
			text += `\n@${item.path}`;
		}
	}
	return { text: text.trim(), images };
}

function parseDataUrl(value) {
	const match = /^data:([^;,]+);base64,(.*)$/s.exec(value);
	if (!match) return null;
	return { type: "image", mimeType: match[1], data: match[2] };
}

function mimeTypeFromPath(filePath) {
	switch (path.extname(filePath).toLowerCase()) {
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".gif":
			return "image/gif";
		case ".webp":
			return "image/webp";
		default:
			return "image/png";
	}
}

export function piModelId(model) {
	return `${model.provider}/${model.id}`;
}

const REASONING_EFFORT_ORDER = new Map(
	["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "persistent"]
		.map((effort, index) => [effort, index]),
);

export function modelToCodex(model, selected = false) {
	const reasoning = model.reasoning !== false;
	const mappedEfforts =
		model.thinkingLevelMap && typeof model.thinkingLevelMap === "object"
			? Object.entries(model.thinkingLevelMap)
					.filter(([, value]) => value !== null)
					.map(([level]) => (level === "off" ? "none" : level))
					.sort((left, right) =>
						(REASONING_EFFORT_ORDER.get(left) ?? Number.MAX_SAFE_INTEGER) -
						(REASONING_EFFORT_ORDER.get(right) ?? Number.MAX_SAFE_INTEGER),
					)
			: [];
	const efforts = reasoning
		? [...new Set(mappedEfforts.length ? mappedEfforts : ["minimal", "low", "medium", "high"])]
		: ["none"];
	const configuredDefault =
		typeof model.defaultThinkingLevel === "string"
			? model.defaultThinkingLevel === "off"
				? "none"
				: model.defaultThinkingLevel
			: null;
	const defaultReasoningEffort =
		configuredDefault && efforts.includes(configuredDefault)
			? configuredDefault
			: efforts.includes("medium")
				? "medium"
				: efforts[0];
	return {
		id: piModelId(model),
		model: piModelId(model),
		modelProviderId: model.provider,
		displayName: model.name || `${model.provider}/${model.id}`,
		description: `${model.provider} via Pi`,
		contextWindow: Number.isFinite(model.contextWindow) ? model.contextWindow : null,
		maxContextWindow: Number.isFinite(model.contextWindow) ? model.contextWindow : null,
		autoCompactTokenLimit: null,
		defaultReasoningEffort,
		supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
			reasoningEffort,
			description: reasoningEffort,
		})),
		isDefault: selected,
		hidden: false,
		inputModalities: Array.isArray(model.input) ? model.input : ["text"],
		supportsPersonality: false,
		modelFamily: modelFamily(model),
		harnessMode: "auto",
		configName: null,
		serviceTiers: [],
		defaultServiceTier: null,
		additionalSpeedTiers: [],
		availabilityNux: null,
		upgrade: null,
		upgradeInfo: null,
	};
}

function modelFamily(model) {
	const value = `${model.provider}/${model.id}`.toLowerCase();
	if (value.includes("claude")) return "claude";
	if (value.includes("gemini")) return "gemini";
	if (value.includes("deepseek")) return "deepseek";
	if (value.includes("doubao")) return "doubao";
	if (value.includes("seed")) return "seed";
	if (value.includes("gpt") || value.includes("openai")) return "gpt";
	return "generic";
}

export function threadFromSessionInfo(info, cliVersion, turns = [], projectId = null) {
	const created = Math.floor(new Date(info.created).getTime() / 1000);
	const updated = Math.floor(new Date(info.modified).getTime() / 1000);
	return {
		id: info.id,
		sessionId: info.id,
		projectId,
		preview: info.firstMessage || "",
		name: info.name || null,
		cwd: info.cwd || process.cwd(),
		path: info.path || null,
		cliVersion,
		source: "appServer",
		modelProvider: "pi",
		createdAt: Number.isFinite(created) ? created : nowSeconds(),
		updatedAt: Number.isFinite(updated) ? updated : nowSeconds(),
		status: { type: "notLoaded" },
		ephemeral: false,
		turns,
	};
}

export function blankThread({
	id,
	cwd,
	sessionFile,
	name,
	modelProvider,
	cliVersion,
	ephemeral,
	projectId = null,
}) {
	const now = nowSeconds();
	return {
		id,
		sessionId: id,
		projectId,
		preview: "",
		name: name || null,
		cwd,
		path: sessionFile || null,
		cliVersion,
		source: "appServer",
		modelProvider: modelProvider || "pi",
		createdAt: now,
		updatedAt: now,
		status: { type: "idle" },
		ephemeral: Boolean(ephemeral),
		turns: [],
	};
}

export function entriesToTurns(entries, { cwd = process.cwd() } = {}) {
	const turns = [];
	let current = null;
	let projectedTurn = false;
	let itemIds = null;
	let dynamicTools = [];
	const toolItems = new Map();
	const compactionTurns = new Map((Array.isArray(entries) ? entries : [])
		.filter(entry => entry?.type === "custom" && entry.customType === "codex-app-pi.compaction-turn" && entry.data?.entryId && entry.data?.turn)
		.map(entry => [entry.data.entryId, entry.data.turn]));
	const savedItemIds = new Map((Array.isArray(entries) ? entries : [])
		.filter((entry) => entry?.type === "custom" && entry.customType === "codex-app-pi.item" && entry.data?.entryId)
		.map((entry) => [entry.data.entryId, entry.data]));
	for (const entry of Array.isArray(entries) ? entries : []) {
		if (!entry || typeof entry !== "object") continue;
		if (entry.type === "custom" && entry.customType === "codex-app-pi.dynamic-tools") {
			dynamicTools = flattenDynamicTools(entry.data?.tools);
			continue;
		}
		if (entry.type === "custom" && entry.customType === "codex-app-pi.turn") {
			if (current) turns.push(current);
			current = { ...emptyHistoryTurn(entry), ...entry.data, items: [] };
			projectedTurn = true;
			itemIds = null;
			continue;
		}
		if (entry.type === "custom" && entry.customType === "codex-app-pi.input") {
			if (current && entry.data?.type === "userMessage") current.items.push({ ...entry.data, content: normalizeCodexInput(entry.data.content) });
			continue;
		}
		if (entry.type === "custom" && entry.customType === "codex-app-pi.item") {
			if (!entry.data?.entryId) itemIds = entry.data;
			continue;
		}
		if (entry.type === "custom" && entry.customType === "codex-app-pi.turn-end") {
			if (current?.id === entry.data?.id) Object.assign(current, entry.data);
			projectedTurn = false;
			continue;
		}
		if (entry.type === "compaction") {
			const savedTurn = compactionTurns.get(entry.id);
			if (savedTurn) {
				if (current) turns.push(current);
				current = { ...savedTurn, items: [] };
				projectedTurn = false;
				itemIds = null;
			}
			current ||= emptyHistoryTurn(entry);
			current.items.push({ type: "contextCompaction", id: entry.id });
			continue;
		}
		if (entry.type === "custom_message" && entry.display) {
			current ||= emptyHistoryTurn(entry);
			current.items.push({
				type: "agentMessage",
				id: savedItemIds.get(entry.id)?.custom || itemIds?.custom || entry.id,
				text: contentText(entry.content),
				phase: "commentary",
				memoryCitation: null,
			});
			itemIds = null;
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (!message || typeof message !== "object") continue;
		if (message.role === "user") {
			const mappedUserId = itemIds?.user;
			const item = { type: "userMessage", id: mappedUserId || entry.id, content: contentToUserInput(message.content) };
			itemIds = null;
			if (projectedTurn && current && mappedUserId) {
				current.items.push(item);
				continue;
			}
			projectedTurn = false;
			if (current) turns.push(current);
			current = {
				id: `turn-${entry.id}`,
				status: "completed",
				items: [item],
				itemsView: "full",
				startedAt: timestampSeconds(message.timestamp),
				completedAt: timestampSeconds(message.timestamp),
				durationMs: 0,
				error: null,
			};
			continue;
		}
		current ||= emptyHistoryTurn(entry);
		if (message.role === "toolResult") {
			const item = toolItems.get(message.toolCallId);
			if (item) completeToolItem(item, message, message.isError);
		} else {
			const items = messageToItems(message, entry.id, cwd, itemIds, dynamicTools);
			itemIds = null;
			for (const item of items) {
				current.items.push(item);
				if (item.type === "dynamicToolCall" || item.type === "commandExecution") toolItems.set(item.id, item);
			}
		}
		if (message.role === "assistant" && !projectedTurn) Object.assign(current, terminalState(message));
		current.completedAt = timestampSeconds(message.timestamp);
	}
	if (current) turns.push(current);
	return turns;
}

function emptyHistoryTurn(entry) {
	const timestamp = timestampSeconds(entry.timestamp ? Date.parse(entry.timestamp) : undefined);
	return {
		id: `turn-${entry.id}`,
		status: "completed",
		items: [],
		itemsView: "full",
		startedAt: timestamp,
		completedAt: timestamp,
		durationMs: 0,
		error: null,
	};
}

export function normalizeCodexInput(input) {
	return (Array.isArray(input) ? input : []).map((item) =>
		item?.type === "text" ? { ...item, text_elements: Array.isArray(item.text_elements) ? item.text_elements : [] } : item,
	);
}

export function contentToUserInput(content) {
	if (typeof content === "string") return [{ type: "text", text: content, text_elements: [] }];
	const result = [];
	for (const item of Array.isArray(content) ? content : []) {
		if (item.type === "text") result.push({ type: "text", text: item.text || "", text_elements: [] });
		if (item.type === "image") {
			result.push({
				type: "image",
				url: `data:${item.mimeType || "image/png"};base64,${item.data || ""}`,
			});
		}
	}
	return result;
}

function messageToItems(message, entryId, cwd, itemIds, dynamicTools) {
	if (message.role === "assistant") {
		const items = [];
		const text = [];
		const thinking = [];
		for (const block of Array.isArray(message.content) ? message.content : []) {
			if (block.type === "text") text.push(block.text || "");
			else if (block.type === "thinking") thinking.push(block.thinking || "");
			else if (block.type === "toolCall") {
				items.push(toolItem({ cwd, dynamicTools }, { toolCallId: block.id, toolName: block.name, args: block.arguments }, "inProgress"));
			}
		}
		if (thinking.length) {
			items.unshift({
				type: "reasoning",
				id: itemIds?.reasoning || `${entryId}-reasoning`,
				summary: [],
				content: thinking,
			});
		}
		if (text.length) {
			items.push({
				type: "agentMessage",
				id: itemIds?.text || `${entryId}-text`,
				text: text.join(""),
				phase: null,
				memoryCitation: null,
			});
		}
		if (itemIds?.order) {
			const rank = new Map(itemIds.order.map((id, index) => [id, index]));
			items.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
		}
		return items;
	}
	if (message.role === "bashExecution") {
		return [
			{
				type: "commandExecution",
				id: entryId,
				command: message.command || "",
				commandActions: [],
				cwd,
				status: message.cancelled ? "declined" : message.exitCode === 0 ? "completed" : "failed",
				aggregatedOutput: message.output || "",
				exitCode: message.exitCode ?? null,
				durationMs: null,
				processId: null,
				source: "userShell",
				yieldTimeMs: null,
			},
		];
	}
	if (message.role === "custom" && message.display) {
		return [
			{
				type: "agentMessage",
				id: entryId,
				text: contentText(message.content),
				phase: "commentary",
				memoryCitation: null,
			},
		];
	}
	if (message.role === "compactionSummary") {
		return [{ type: "contextCompaction", id: entryId }];
	}
	return [];
}

export function terminalState(message) {
	return {
		status: message?.stopReason === "aborted" ? "interrupted" : message?.stopReason === "error" ? "failed" : "completed",
		error: message?.stopReason === "error" ? { message: message.errorMessage || "Pi model request failed" } : null,
	};
}

export function toolItem(runtime, event, status) {
	if (event.toolName === "bash") {
		return {
			type: "commandExecution", id: event.toolCallId, command: event.args?.command || "",
			commandActions: [], cwd: runtime.cwd, status, aggregatedOutput: "", exitCode: null,
			durationMs: null, processId: null, source: "agent", yieldTimeMs: null,
		};
	}
	const desktop = runtime.dynamicTools.find((tool) => tool.name === event.toolName);
	return {
		type: "dynamicToolCall", id: event.toolCallId, tool: event.toolName,
		namespace: desktop?.namespace || null, arguments: event.args || {}, status,
		contentItems: null, success: null, durationMs: null,
	};
}

export function completeToolItem(item, result, isError) {
	item.status = isError ? "failed" : "completed";
	if (item.type === "commandExecution") {
		item.aggregatedOutput = contentText(result?.content);
		item.exitCode = result?.details?.exitCode ?? (isError ? 1 : 0);
	} else {
		item.success = !isError;
		item.contentItems = (Array.isArray(result?.content) ? result.content : []).map((block) =>
			block.type === "image"
				? { type: "inputImage", imageUrl: `data:${block.mimeType || "image/png"};base64,${block.data || ""}` }
				: { type: "inputText", text: block.text || "" },
		);
	}
	return item;
}

export function contentText(content) {
	if (typeof content === "string") return content;
	return (Array.isArray(content) ? content : [])
		.filter((item) => item && item.type === "text")
		.map((item) => item.text || "")
		.join("");
}

function timestampSeconds(value) {
	return Number.isFinite(value) ? Math.floor(value / 1000) : nowSeconds();
}

export function usageBreakdown(usage = {}) {
	const inputTokens = number(usage.input);
	const outputTokens = number(usage.output);
	const cachedInputTokens = number(usage.cacheRead);
	const cacheCreationInputTokens = number(usage.cacheWrite);
	const reasoningOutputTokens = number(usage.reasoning);
	return {
		inputTokens,
		cachedInputTokens,
		cacheCreationInputTokens,
		outputTokens,
		reasoningOutputTokens,
		totalTokens:
			number(usage.totalTokens ?? usage.total) ||
			inputTokens + outputTokens + cachedInputTokens + cacheCreationInputTokens,
	};
}

function number(value) {
	return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

export function codexResultToPi(result) {
	const contentItems = Array.isArray(result?.contentItems) ? result.contentItems : [];
	const content = contentItems.map((item) =>
		item?.type === "inputImage"
			? { type: "image", data: dataFromUrl(item.imageUrl), mimeType: mimeFromUrl(item.imageUrl) }
			: { type: "text", text: item?.text || "" },
	);
	return {
		content: content.length ? content : [{ type: "text", text: "" }],
		details: result,
		isError: result?.success === false,
	};
}

function dataFromUrl(value = "") {
	const parsed = parseDataUrl(value);
	return parsed?.data || "";
}

function mimeFromUrl(value = "") {
	const parsed = parseDataUrl(value);
	return parsed?.mimeType || "image/png";
}

// Only used with an explicitly isolated test agent directory. No model network.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadPiSdk } from "../src/pi-sdk.mjs";
export default async function (pi) {
	const sdk = await loadPiSdk();
	const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import(pathToFileURL(path.join(sdk.packageRoot, "node_modules/@earendil-works/pi-ai/dist/providers/faux.js")).href);
	const faux = fauxProvider({ provider: "desktop-test", models: [{ id: "faux", name: "Desktop acceptance (offline)", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 2048 }] });
	const response = (context) => {
		const last = context.messages.at(-1);
		if (last?.role === "toolResult") return fauxAssistantMessage("ACCEPTANCE_DONE: " + last.content.filter(b => b.type === "text").map(b => b.text).join(""));
		const user = [...context.messages].reverse().find(m => m.role === "user");
		const text = typeof user?.content === "string" ? user.content : user?.content?.filter(b => b.type === "text").map(b => b.text).join("") || "";
		if (/APPROVAL/.test(text)) return fauxAssistantMessage([fauxToolCall("acceptance_confirm", {})], { stopReason: "toolUse" });
		if (/DISCONNECT/.test(text)) return fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 8; printf PERSISTENT_LINUX_OK" })], { stopReason: "toolUse" });
		if (/TOOL/.test(text)) return fauxAssistantMessage([fauxToolCall("bash", { command: "printf ACCEPTANCE_TOOL_OK" })], { stopReason: "toolUse" });
		return fauxAssistantMessage("ACCEPTANCE_REPLY: " + text);
	};
	faux.setResponses(Array(100).fill(response));
	pi.registerProvider(faux.provider);
	pi.registerTool({ name: "acceptance_confirm", label: "Acceptance approval", description: "Request explicit fixture approval", parameters: sdk.Type.Object({}),
		async execute(_id, _args, signal, _update, ctx) {
			const ok = await ctx.ui.confirm("Acceptance approval", "Allow this harmless test?", { signal });
			return { content: [{ type: "text", text: ok ? "APPROVED" : "DENIED" }], details: {} };
		},
	});
}

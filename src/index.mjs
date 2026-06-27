import { estimateTokens as estimateTokensFromChars } from "@cline/shared";

const MAX_INPUT_TOKENS = 120_000;
const COMPACT_AT_RATIO = 0.75;
const PRESERVE_RECENT_TOKENS = 24_000;
const SUMMARY_PREVIEW_CHARS = 800;
const SCHEMA_VERSION = 1;

function estimateTokens(text) {
	return estimateTokensFromChars(text.length);
}

function preview(text, limit = SUMMARY_PREVIEW_CHARS) {
	if (text.length <= limit) return text.trim();
	return `${text.slice(0, limit).trim()}\n...[${text.length - limit} more chars summarized]`;
}

function stringifyContent(content) {
	return typeof content === "string" ? content : JSON.stringify(content);
}

function serializeMessage(message) {
	if (typeof message.content === "string") {
		return `[${message.role}]: ${message.content}`;
	}
	const lines = [];
	for (const block of message.content) {
		switch (block.type) {
			case "text":
				lines.push(`[${message.role}]: ${block.text ?? ""}`);
				break;
			case "thinking":
				lines.push(`[assistant thinking]: ${preview(block.thinking ?? "", 300)}`);
				break;
			case "tool_use":
				lines.push(`[assistant tool call]: ${block.name ?? "tool"}(${JSON.stringify(block.input ?? {})})`);
				break;
			case "tool_result":
				lines.push(`[tool result ${block.tool_use_id ?? "unknown"}]: ${preview(stringifyContent(block.content), 500)}`);
				break;
			case "file":
				lines.push(`[file ${block.path ?? "unknown"}]: ${preview(String(block.content ?? ""), 500)}`);
				break;
			default:
				lines.push(`[${message.role} ${block.type} block]`);
		}
	}
	return lines.join("\n");
}

function estimateMessageTokens(message) {
	return estimateTokens(serializeMessage(message));
}

function findFirstUserIndex(messages) {
	return messages.findIndex((msg) => msg.role === "user");
}

function findRecentStartIndex(messages) {
	let tokens = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!msg) continue;
		tokens += estimateMessageTokens(msg);
		if (tokens >= PRESERVE_RECENT_TOKENS) return i;
	}
	return 0;
}

function collectToolNames(messages) {
	const names = new Set();
	for (const msg of messages) {
		if (!Array.isArray(msg.content)) continue;
		for (const block of msg.content) {
			if (block.type === "tool_use" && block.name) names.add(block.name);
		}
	}
	return [...names].sort();
}

function collectTouchedFiles(messages) {
	const paths = new Set();
	for (const msg of messages) {
		if (!Array.isArray(msg.content)) continue;
		for (const block of msg.content) {
			if (block.type === "file" && block.path) paths.add(block.path);
			if (block.type === "tool_use") {
				for (const v of Object.values(block.input ?? {})) {
					if (typeof v === "string" && v.includes("/")) paths.add(v);
				}
			}
		}
	}
	return [...paths].sort();
}

function shouldCompact(messages) {
	const totalTokens = messages.reduce((t, msg) => t + estimateMessageTokens(msg), 0);
	if (totalTokens < MAX_INPUT_TOKENS * COMPACT_AT_RATIO) {
		return false;
	}
	const firstUserIndex = findFirstUserIndex(messages);
	const recentStartIndex = Math.max(firstUserIndex + 1, findRecentStartIndex(messages));
	if (firstUserIndex < 0 || recentStartIndex <= firstUserIndex + 1) return false;
	const compacted = messages.slice(firstUserIndex + 1, recentStartIndex);
	if (compacted.length === 0) return false;
	return true;
}

export const plugin = {
	name: "handoff-plugin",
	manifest: {
		capabilities: ["messageBuilders"],
	},

	async setup(api) {
		api.registerMessageBuilder({
			name: "compact-and-handoff",
			build(messages) {
				if (!shouldCompact(messages)) {
					return messages;
				}
				console.log("[handoff-plugin] compact trigger detected");
				return messages;
			},
		});
		console.log("[handoff-plugin] setup completed successfully");
	},
};

export default plugin;

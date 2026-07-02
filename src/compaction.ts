import type { Message, ToolResultContent } from "@cline/core";
// import { estimateTokens as estimateTokensFromChars } from "@cline/shared";
// NOTE: estimateTokensFromChars returns anomalously low values (~297 for 16K chars).
// Using Math.ceil(text.length / 4) instead. Investigate root cause before re-enabling.

export const MAX_INPUT_TOKENS = 120_000;
export const COMPACT_AT_RATIO = 0.75;
const PRESERVE_RECENT_TOKENS = 24_000;
const SUMMARY_PREVIEW_CHARS = 800;

export interface CompactResult {
	needsCompact: boolean;
	totalTokens: number;
	messages: Message[];
}

// estimateTokensFromChars from @cline/shared returns anomalously low values
// (~297 for 16K chars). Using standard 4-chars-per-token approximation instead.
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function preview(text: string, limit = SUMMARY_PREVIEW_CHARS): string {
	if (text.length <= limit) {
		return text.trim();
	}
	return `${text.slice(0, limit).trim()}\n...[${text.length - limit} more chars summarized]`;
}

function stringifyContent(content: ToolResultContent["content"]): string {
	return typeof content === "string" ? content : JSON.stringify(content);
}

function serializeMessage(message: Message): string {
	if (typeof message.content === "string") {
		return `[${message.role}]: ${message.content}`;
	}
	const lines: string[] = [];
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
				lines.push(`[${message.role} ${block.type}]: ${JSON.stringify(block).slice(0, 2000)}`);
		}
	}
	return lines.join("\n");
}

function estimateMessageTokens(message: Message): number {
	return estimateTokens(serializeMessage(message));
}

function findFirstUserIndex(messages: Message[]): number {
	return messages.findIndex((message) => message.role === "user");
}

function findRecentStartIndex(messages: Message[]): number {
	let tokens = 0;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!message) continue;
		tokens += estimateMessageTokens(message);
		if (tokens >= PRESERVE_RECENT_TOKENS) return index;
	}
	return 0;
}

export function collectToolNames(messages: Message[]): string[] {
	const names = new Set<string>();
	for (const message of messages) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block.type === "tool_use" && block.name) names.add(block.name);
		}
	}
	return [...names].sort((a, b) => a.localeCompare(b));
}

export function collectTouchedFiles(messages: Message[]): string[] {
	const paths = new Set<string>();
	for (const message of messages) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block.type === "file" && block.path) paths.add(block.path);
			if (block.type === "tool_use") {
				for (const value of Object.values(block.input ?? {})) {
					if (typeof value === "string" && value.includes("/")) paths.add(value);
				}
			}
		}
	}
	return [...paths].sort((a, b) => a.localeCompare(b));
}

export function buildCompactionSummary(compacted: Message[], tokensBefore: number): Message {
	const roleCounts = compacted.reduce<Record<string, number>>((counts, msg) => {
		counts[msg.role] = (counts[msg.role] ?? 0) + 1;
		return counts;
	}, {});
	const tools = collectToolNames(compacted);
	const files = collectTouchedFiles(compacted);
	const highlights = compacted.map(serializeMessage).map((l) => preview(l, 500)).slice(-6);

	// F1 fix (2026-07-02): content must be ContentBlock[] to avoid §1.15 codec bug.
	// codec Nd function calls n.content.map(eK) — string has no .map(), would crash
	// if this message ever reaches the decode boundary. Same root cause as A1 (index.ts:146).
	const summaryText = `Context summary:

## Compacted Range
- Messages compacted: ${compacted.length}
- Estimated tokens before compaction: ${tokensBefore}
- Roles: ${Object.entries(roleCounts).map(([r, c]) => `${r}=${c}`).join(", ")}

## Tool Activity
${tools.length > 0 ? tools.map((t) => `- ${t}`).join("\n") : "- none"}

## Files Mentioned
${files.length > 0 ? files.map((p) => `- ${p}`).join("\n") : "- none"}

## Recent Highlights From Compacted History
${highlights.length > 0 ? highlights.map((l) => `- ${l}`).join("\n") : "- none"}

Continue from this summary plus the preserved recent messages below.`;

	return {
		role: "user",
		content: [{ type: "text", text: summaryText }],
	};
}

export function shouldCompact(messages: Message[]): CompactResult {
	const totalTokens = messages.reduce((total, msg) => total + estimateMessageTokens(msg), 0);
	if (totalTokens < MAX_INPUT_TOKENS * COMPACT_AT_RATIO) {
		return { needsCompact: false, totalTokens, messages };
	}
	const firstUserIndex = findFirstUserIndex(messages);
	const recentStartIndex = Math.max(firstUserIndex + 1, findRecentStartIndex(messages));
	if (firstUserIndex < 0 || recentStartIndex <= firstUserIndex + 1) {
		return { needsCompact: false, totalTokens, messages };
	}
	const prefix = messages.slice(0, firstUserIndex + 1);
	const compacted = messages.slice(firstUserIndex + 1, recentStartIndex);
	const recent = messages.slice(recentStartIndex);
	if (compacted.length === 0) {
		return { needsCompact: false, totalTokens, messages };
	}
	return {
		needsCompact: true,
		totalTokens,
		messages: [...prefix, buildCompactionSummary(compacted, totalTokens), ...recent],
	};
}

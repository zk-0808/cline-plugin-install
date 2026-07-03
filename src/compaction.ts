import type { Message } from "@cline/core";

// ─── 阶段 1 清理（thin-adapter-layer project-rules §3）───
// 已删除（重造原生轮子，违反 ADR-006 §0 元原则）：
//   - MAX_INPUT_TOKENS / COMPACT_AT_RATIO / PRESERVE_RECENT_TOKENS / SUMMARY_PREVIEW_CHARS 常量
//   - estimateTokens / preview / stringifyContent / serializeMessage / estimateMessageTokens
//   - findFirstUserIndex / findRecentStartIndex
//   - buildCompactionSummary（死代码：计算了 result.messages 但 index.ts 未使用）
//   - shouldCompact（重造原生触发判断）
//   - CompactResult interface
// 保留：collectToolNames / collectTouchedFiles（被 index.ts + snapshot-writer.ts 使用）

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

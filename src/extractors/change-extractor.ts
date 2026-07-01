import type { Message, ChangeRecord, EvidenceRef, Extractor } from "../types";

/**
 * Change extractor — extracts file changes and tool usage from messages.
 *
 * v0.7.0 improvements over v0.6.0:
 * - Distinguishes file-created vs file-modified
 * - Records tool usage as structured ChangeRecord
 * - EvidenceRef with message index for traceability
 */
export const changeExtractor: Extractor<ChangeRecord> = {
	name: "change-extractor",

	extract(messages: Message[], tools: string[], files: string[]): ChangeRecord[] {
		const changes: ChangeRecord[] = [];
		const seenPaths = new Set<string>();
		const seenTools = new Set<string>();

		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i];
			if (!Array.isArray(msg.content)) continue;

			for (const block of msg.content) {
				// File blocks
				if (block.type === "file" && block.path) {
					const path = block.path as string;
					if (!seenPaths.has(path)) {
						seenPaths.add(path);
						const excerpt = `file: ${path}`.slice(0, 100);
						changes.push({
							kind: "file-modified",
							path,
							confidence: "high",
							evidence: [{ messageIndex: i, role: msg.role, excerpt }],
						});
					}
				}

				// Tool use blocks — extract file paths and tool names
				if (block.type === "tool_use") {
					const toolName = block.name as string;

					// Record tool usage
					if (toolName && !seenTools.has(toolName)) {
						seenTools.add(toolName);
						changes.push({
							kind: "tool-used",
							toolName,
							confidence: "high",
							evidence: [{ messageIndex: i, role: "assistant", excerpt: `tool: ${toolName}` }],
						});
					}

					// Extract file paths from tool input
					if (block.input) {
						for (const value of Object.values(block.input)) {
							if (typeof value === "string" && value.includes("/") && !seenPaths.has(value)) {
								// Looks like a file path
								if (/\.(md|ts|js|json|yaml|yml|ps1|sh|py|txt)$/i.test(value)) {
									seenPaths.add(value);
									changes.push({
										kind: "file-modified",
										path: value,
										confidence: "medium",
										evidence: [{ messageIndex: i, role: "assistant", excerpt: `path in ${toolName}: ${value.slice(0, 60)}` }],
									});
								}
							}
						}
					}
				}
			}
		}

		// Also collect from the pre-computed tools and files lists (v0.6.0 compatibility)
		for (const tool of tools) {
			if (!seenTools.has(tool)) {
				seenTools.add(tool);
				changes.push({
					kind: "tool-used",
					toolName: tool,
					confidence: "medium",
					evidence: [{ messageIndex: -1, role: "assistant", excerpt: `tool (from summary): ${tool}` }],
				});
			}
		}

		for (const file of files) {
			if (!seenPaths.has(file)) {
				seenPaths.add(file);
				changes.push({
					kind: "file-modified",
					path: file,
					confidence: "low",
					evidence: [{ messageIndex: -1, role: "assistant", excerpt: `file (from summary): ${file}` }],
				});
			}
		}

		return changes;
	},
};

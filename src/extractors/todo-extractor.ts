import type { Message, TodoRecord, EvidenceRef, Extractor } from "../types";

const USER_TODO = /\b(todo|unfinished|next|remaining|still need|pending|follow[- ]up|未完成|下一步|待跟进|后续)\b/i;
const ASSISTANT_TODO = /(下一步|待跟进|未完成|后续动作|remaining|follow[- ]up)/i;

/**
 * Todo extractor — extracts unfinished items and next steps.
 *
 * v0.7.0 improvements over v0.6.0:
 * - Scans assistant messages (not just user)
 * - Priority inference from context
 * - blockerRef field reserved for v0.8+ dependency graph
 */
export const todoExtractor: Extractor<TodoRecord> = {
	name: "todo-extractor",

	extract(messages: Message[]): TodoRecord[] {
		const todos: TodoRecord[] = [];

		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i];
			const text = typeof msg.content === "string" ? msg.content : "";

			if (msg.role === "user" && USER_TODO.test(text)) {
				const excerpt = text.slice(0, 100).replace(/\n/g, " ").trim();
				const evidence: EvidenceRef = { messageIndex: i, role: "user", excerpt };

				// Priority inference
				const isHigh = /\b(urgent|critical|block|阻塞|紧急|必须)\b/i.test(text);
				const priority = isHigh ? "high" : "tbd";

				todos.push({
					direction: excerpt,
					priority,
					confidence: "medium",
					evidence: [evidence],
				});
			} else if (msg.role === "assistant" && ASSISTANT_TODO.test(text)) {
				const excerpt = text.slice(0, 100).replace(/\n/g, " ").trim();
				const evidence: EvidenceRef = { messageIndex: i, role: "assistant", excerpt };

				todos.push({
					direction: excerpt,
					priority: "tbd",
					confidence: "low",
					evidence: [evidence],
				});
			}
		}

		return todos;
	},
};

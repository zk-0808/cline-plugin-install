import type { Message, TodoRecord, EvidenceRef, Extractor } from "../types";

const USER_TODO = /\b(todo|unfinished|next|remaining|still need|pending|follow[- ]up|未完成|下一步|待跟进|后续)\b/i;
const ASSISTANT_TODO = /(下一步|待跟进|未完成|后续动作|remaining|follow[- ]up)/i;

const PRIORITY_SORT: Record<string, number> = { high: 0, medium: 1, low: 2, tbd: 3 };
const CONFIDENCE_SORT: Record<string, number> = { Verified: 0, Likely: 1, Hypothesis: 2 };

// ─── schema V2 §1.5 Handoff 表格解析 ───
// 识别 handoff.md 中的"未完成项"表格片段，提取六字段（id/kind/exitWhen/confidence/dependsOn/blockerRef）。
// 表头格式（见 docs/handoff.md）：
//   | id | 方向 | 说明 | 优先级 | confidence | depends_on | blocker_ref |
// 或简化三字段格式：
//   | id | 方向 | confidence | depends_on |
//
// 表头识别策略：不依赖标题行（`## 未完成项` 与表格可能跨行），
// 直接扫描含 `|` 且首列为 `id` 的行作为表头。

const HANDOFF_HEADER_RE = /^\|\s*`?id`?\s*\|/i;
const TABLE_ROW_RE = /^\|(.+)\|$/;
// separator 行允许内部多个 |（如 |----|------|------|），所以字符类含 |
const TABLE_SEPARATOR_RE = /^\|[\s:|-]+$/;

/** 从文本中解析 handoff.md 未完成项表格，返回结构化 TodoRecord[] */
function parseHandoffTable(text: string, baseMsgIndex: number, role: string): TodoRecord[] {
	const lines = text.split("\n");
	const todos: TodoRecord[] = [];
	let inTable = false;
	let columns: string[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		// 进入表格：表头行匹配 `| id | ... |`（不要求标题在同一行）
		if (!inTable && HANDOFF_HEADER_RE.test(line)) {
			columns = line.split("|").map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0);
			if (columns.includes("id")) {
				inTable = true;
			}
			continue;
		}

		if (inTable) {
			// 跳过分隔行 |----|----|
			if (TABLE_SEPARATOR_RE.test(line)) continue;

			const rowMatch = TABLE_ROW_RE.exec(line);
			if (!rowMatch) {
				// 表格结束
				inTable = false;
				continue;
			}

			const cells = rowMatch[1].split("|").map((s) => s.trim());
			if (cells.length === 0) continue;

			const row: Record<string, string> = {};
			for (let j = 0; j < columns.length && j < cells.length; j++) {
				row[columns[j]] = cells[j];
			}

			// 必须有 id 才算有效条目；清理 backtick 包裹
			const rawId = (row.id || "").replace(/^`|`$/g, "");
			if (!rawId || rawId === "—") continue;

			const confidence = normalizeConfidence(row.confidence);
			const dependsOn = parseDependsOn(row.depends_on);
			const blockerRef = parseBlockerRef(row.blocker_ref, row.depends_on);
			// 列名兼容：表头可能是中文"优先级"或英文"priority"
			const priority = parsePriority(row.priority || row["优先级"]);

			// 清理 direction 中 backtick 包裹
			const direction = (row.direction || row["方向"] || rawId).replace(/`/g, "");

			const excerpt = `handoff.md table row: id=${rawId}`.slice(0, 100);

			todos.push({
				id: rawId,
				direction,
				priority,
				confidence,
				kind: row.kind ? (row.kind as "conclusion" | "action") : undefined,
				exitWhen: row.exit_when || row["exit_when"] || undefined,
				dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
				blockerRef: blockerRef || undefined,
				evidence: [{ messageIndex: baseMsgIndex, role, excerpt }],
			});
		}
	}

	return todos;
}

/** 把各种 confidence 写法归一化为 schema §1.0 状态机词汇 */
function normalizeConfidence(raw: string | undefined): "Verified" | "Likely" | "Hypothesis" {
	if (!raw) return "Hypothesis";
	const v = raw.toLowerCase().trim();
	if (v.includes("verified") || v.includes("高") || v === "high") return "Verified";
	if (v.includes("likely") || v.includes("中") || v === "medium") return "Likely";
	return "Hypothesis";
}

/** 解析 depends_on 列：逗号分隔的 Handoff ID 列表，过滤掉 Blocker ID（B- 前缀） */
function parseDependsOn(raw: string | undefined): string[] {
	if (!raw || raw === "—" || raw === "-") return [];
	return raw
		.split(/[,，]/)
		.map((s) => s.trim().replace(/`/g, ""))
		.filter((s) => s.length > 0 && !s.startsWith("B-"));
}

/** 解析 blocker_ref 列：必须以 B- 前缀标识；若 depends_on 误写 B- 前缀也归入 blocker_ref */
function parseBlockerRef(blockerRaw: string | undefined, dependsOnRaw: string | undefined): string {
	const candidates: string[] = [];
	const clean = (s: string) => s.trim().replace(/`/g, "");
	if (blockerRaw && blockerRaw !== "—" && blockerRaw !== "-") {
		candidates.push(...blockerRaw.split(/[,，]/).map(clean));
	}
	if (dependsOnRaw) {
		candidates.push(
			...dependsOnRaw
				.split(/[,，]/)
				.map(clean)
				.filter((s) => s.startsWith("B-")),
		);
	}
	const blocker = candidates.find((s) => s.startsWith("B-"));
	return blocker || "";
}

/** 优先级解析：emoji + 文本 → 标准枚举 */
function parsePriority(raw: string | undefined): "high" | "medium" | "low" | "tbd" {
	if (!raw) return "tbd";
	const v = raw.toLowerCase();
	if (v.includes("高") || v.includes("high") || v.includes("🔴")) return "high";
	if (v.includes("中") || v.includes("medium") || v.includes("🟡")) return "medium";
	if (v.includes("低") || v.includes("low") || v.includes("🟢")) return "low";
	return "tbd";
}

/**
 * Todo extractor — extracts unfinished items and next steps.
 *
 * v0.8.0 (schema V2 §1.5 align):
 * - 新增 handoff.md 表格解析（parseHandoffTable）提取六字段结构化数据
 * - Confidence 词汇对齐 schema §1.0（Verified/Likely/Hypothesis，不再是 high/medium/low）
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
		const seenIds = new Set<string>();
		const messagesWithTable = new Set<number>();

		// Pass 1: handoff.md 表格解析（高优先级——若消息中含完整表格，以表格为准）
		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i];
			const text = typeof msg.content === "string" ? msg.content : "";
			const tableTodos = parseHandoffTable(text, i, msg.role);
			if (tableTodos.length > 0) {
				messagesWithTable.add(i);
			}
			for (const t of tableTodos) {
				if (t.id && !seenIds.has(t.id)) {
					seenIds.add(t.id);
					todos.push(t);
				}
			}
		}

		// Pass 2: 关键词模式提取（跳过已被 Pass 1 表格解析的消息，避免重复提取）
		for (let i = 0; i < messages.length; i++) {
			if (messagesWithTable.has(i)) continue;
			const msg = messages[i];
			const text = typeof msg.content === "string" ? msg.content : "";

			if (msg.role === "user" && USER_TODO.test(text)) {
				const excerpt = text.slice(0, 100).replace(/\n/g, " ").trim();
				const evidence: EvidenceRef = { messageIndex: i, role: "user", excerpt };

				const isHigh = /\b(urgent|critical|block|阻塞|紧急|必须)\b/i.test(text);
				const priority = isHigh ? "high" : "tbd";

				todos.push({
					direction: excerpt,
					priority,
					confidence: "Likely",
					evidence: [evidence],
				});
			} else if (msg.role === "assistant" && ASSISTANT_TODO.test(text)) {
				const excerpt = text.slice(0, 100).replace(/\n/g, " ").trim();
				const evidence: EvidenceRef = { messageIndex: i, role: "assistant", excerpt };

				todos.push({
					direction: excerpt,
					priority: "tbd",
					confidence: "Hypothesis",
					evidence: [evidence],
				});
			}
		}

		// 排序：表格提取的（有 id）优先；其次 priority；其次 confidence
		return todos.sort((a, b) => {
			const aHasId = a.id ? 0 : 1;
			const bHasId = b.id ? 0 : 1;
			if (aHasId !== bHasId) return aHasId - bHasId;
			const pDiff = (PRIORITY_SORT[a.priority] ?? 999) - (PRIORITY_SORT[b.priority] ?? 999);
			if (pDiff !== 0) return pDiff;
			return (CONFIDENCE_SORT[a.confidence] ?? 999) - (CONFIDENCE_SORT[b.confidence] ?? 999);
		});
	},
};

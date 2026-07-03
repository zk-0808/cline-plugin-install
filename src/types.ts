import type { Message } from "@cline/core";

/** Schema for snapshot metadata entries (reserved for future index support) */
export interface SnapshotEntry {
	timestamp: string;
	messageCount: number;
	toolCalls: string[];
	filePaths: string[];
	decisions: string[];
	unfinishedItems: string[];
}

export { type Message };

// ─── v0.7.0 Data Model ───

/**
 * Confidence vocabulary — schema §1.0 状态机词汇（Verified/Likely/Hypothesis）。
 * 与 evidence-governance.md §4（高/中/低）通过 schema §1.0 表对齐，字面不一致。
 */
export type Confidence = "Verified" | "Likely" | "Hypothesis";

/** Evidence reference — records extraction source for traceability */
export interface EvidenceRef {
	messageIndex: number;
	role: string; // "user" | "assistant" | "system" | "tool"
	excerpt: string; // ≤100 chars
}

/** Base class for all extracted records */
export interface ExtractedRecord {
	confidence: Confidence;
	evidence: EvidenceRef[]; // at least 1
}

/** Decision record — §1 "本会话决策" */
export interface DecisionRecord extends ExtractedRecord {
	text: string;
	status: "accepted" | "rejected" | "deferred" | "rolled-back" | "decided";
	category?: "architecture" | "process" | "tooling" | "scope";
}

/** Change record — §2 "本会话净变化" */
export interface ChangeRecord extends ExtractedRecord {
	kind: "file-created" | "file-modified" | "file-deleted" | "tool-used";
	path?: string;
	toolName?: string;
}

/**
 * Todo record — §3 "未完成项"。
 * 字段对齐 schema-semantic-object-model.md V3 §1.5 Handoff 对象（六字段全覆盖）。
 * 命名采用 camelCase（TypeScript 惯例），snake_case 仅在 schema 文档中出现：
 *   - dependsOn ↔ schema depends_on
 *   - exitWhen   ↔ schema exit_when
 *   - blockerRef ↔ schema blocker_ref
 */
export interface TodoRecord extends ExtractedRecord {
	id?: string;                       // schema §1.5 稳定短 ID（若可从 handoff.md 表格提取）
	direction: string;                 // schema §1.5 方向/说明
	priority: "high" | "medium" | "low" | "tbd";
	kind?: "conclusion" | "action";    // schema §1.5
	exitWhen?: string;                 // schema §1.5 退出条件
	dependsOn?: string[];              // schema §1.5 依赖的 Handoff ID 列表（禁止指向 Blocker ID）
	blockerRef?: string;               // schema §1.5 Blocker ID（必须以 `B-` 前缀标识）
}

/** Source record — §4 "权威源" */
export interface SourceRecord extends ExtractedRecord {
	path: string;
	kind: "doc" | "source-code" | "config" | "external";
}

/** Snapshot metadata */
export interface SnapshotMeta {
	title: string;
	timestamp: string;
	messageCount: number;
	toolCount: number;
	fileCount: number;
}

/** Top-level snapshot data model — filled by Extractors, consumed by Renderer */
export interface SnapshotData {
	meta: SnapshotMeta;
	decisions: DecisionRecord[];
	changes: ChangeRecord[];
	todos: TodoRecord[];
	sources: SourceRecord[];
}

/** Extractor interface — each extractor focuses on one record type */
export interface Extractor<T extends ExtractedRecord> {
	name: string;
	extract(messages: Message[], tools: string[], files: string[]): T[];
}

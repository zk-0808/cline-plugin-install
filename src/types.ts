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
 * Confidence vocabulary — maps to evidence-governance.md §4
 * high = Verified, medium = Likely, low = Hypothesis
 */
export type Confidence = "high" | "medium" | "low";

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

/** Todo record — §3 "未完成项" */
export interface TodoRecord extends ExtractedRecord {
	direction: string;
	priority: "high" | "medium" | "low" | "tbd";
	blockerRef?: string; // reserved for v0.8+
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

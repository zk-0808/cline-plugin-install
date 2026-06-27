import type { Message } from "@cline/core";

export interface PluginOptions {
	handoffDir?: string;
	maxInputTokens?: number;
	compactAtRatio?: number;
	preserveRecentTokens?: number;
}

export interface HandoffEntry {
	sessionId: string;
	timestamp: string;
	messageCount: number;
	toolCalls: string[];
	filePaths: string[];
	decisions: string[];
	unfinishedItems: string[];
	authoritySources: string[];
}

export interface IndexEntry {
	schema_version: number;
	source: string;
	session_id: string;
	timestamp: string;
	handoff_path: string;
	summary?: string;
	key_terms?: string[];
	file_count?: number;
	decision_count?: number;
	tool_count?: number;
}

export { type Message };

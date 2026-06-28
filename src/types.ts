import type { Message } from "@cline/core";

export interface PluginOptions {
	handoffDir?: string;
	workspacePath?: string;
}

export interface HandoffEntry {
	timestamp: string;
	messageCount: number;
	toolCalls: string[];
	filePaths: string[];
	decisions: string[];
	unfinishedItems: string[];
}

export { type Message };

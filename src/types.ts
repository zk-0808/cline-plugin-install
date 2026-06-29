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

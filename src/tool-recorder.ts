import type { Message } from "./types";
import { shouldCompact, collectToolNames, collectTouchedFiles } from "./compaction";

export interface ToolCallRecord {
	name: string;
	args: string;
	duration: number;
	success: boolean;
	timestamp: string;
}

const MAX_HISTORY = 100;
const DURATION_WARN_MS = 30_000; // 30s

export class ToolCallRecorder {
	private history: ToolCallRecord[] = [];
	private pending: Map<string, { name: string; args: string; start: number }> = new Map();

	/** Call from beforeTool hook — record start time */
	beforeTool(toolName: string, args: Record<string, unknown>): void {
		const id = `${toolName}-${Date.now()}`;
		this.pending.set(id, {
			name: toolName,
			args: JSON.stringify(args).slice(0, 200),
			start: Date.now(),
		});
	}

	/** Call from afterTool hook — compute duration, store record */
	afterTool(toolName: string, success: boolean): ToolCallRecord | null {
		// Find the most recent pending entry for this tool
		let matchedId: string | null = null;
		for (const [id, entry] of this.pending) {
			if (entry.name === toolName) {
				matchedId = id;
				break;
			}
		}
		if (!matchedId) return null;

		const entry = this.pending.get(matchedId)!;
		this.pending.delete(matchedId);

		const record: ToolCallRecord = {
			name: entry.name,
			args: entry.args,
			duration: Date.now() - entry.start,
			success,
			timestamp: new Date().toISOString(),
		};

		this.history.push(record);
		if (this.history.length > MAX_HISTORY) {
			this.history = this.history.slice(-MAX_HISTORY);
		}

		return record;
	}

	/** Get recent tool call history */
	getHistory(count = 20): ToolCallRecord[] {
		return this.history.slice(-count);
	}

	/** Check for long-running tool calls */
	getSlowCalls(thresholdMs = DURATION_WARN_MS): ToolCallRecord[] {
		return this.history.filter((r) => r.duration > thresholdMs);
	}

	/** Detect repetition patterns (N-gram based) */
	detectRepetition(windowSize = 5, threshold = 3): {
		repeating: boolean;
		pattern: string[];
		count: number;
	} {
		if (this.history.length < windowSize * 2) {
			return { repeating: false, pattern: [], count: 0 };
		}

		const recent = this.history.slice(-windowSize);
		const pattern = recent.map((r) => r.name);

		// Count how many times this exact pattern appears in the last N entries
		let count = 0;
		const searchWindow = this.history.slice(0, -windowSize);
		for (let i = 0; i <= searchWindow.length - windowSize; i++) {
			const slice = searchWindow.slice(i, i + windowSize);
			if (slice.every((r, j) => r.name === pattern[j])) {
				count++;
			}
		}

		return {
			repeating: count >= threshold,
			pattern,
			count: count + 1, // +1 for the current window
		};
	}
}

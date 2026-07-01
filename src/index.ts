import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "./types";
import { shouldCompact, collectToolNames, collectTouchedFiles } from "./compaction";
import { ToolCallRecorder } from "./tool-recorder";
import { buildSnapshotRuleContent } from "./rules-injector";
import { writeSnapshot } from "./snapshot-writer";
import { PLUGIN_NAME, getSnapshotDir } from "./constants";

// ─── Plugin Entry ───

const toolRecorder = new ToolCallRecorder();

// ── V6: Loop Guard shared state (afterTool → registerRule bridge) ──
// afterTool detects repetition and writes here; registerRule.content reads it.
// Warnings go through rules (system prompt), bypassing message codec entirely.
interface LoopState {
	repeating: boolean;
	pattern: string[];
	count: number;
	warningCount: number;
}
const loopState: LoopState = {
	repeating: false,
	pattern: [],
	count: 0,
	warningCount: 0,
};
const MAX_LOOP_WARNINGS = 3;
const LOOP_WINDOW = 5;
const LOOP_THRESHOLD = 3;

export const plugin = {
	name: PLUGIN_NAME,
	manifest: {
		capabilities: ["messageBuilders", "rules", "hooks"],
	},

	setup(api: any, ctx?: any) {
		console.log(`[${PLUGIN_NAME}] setup() called`);

		// ── Marker file ──
		try {
			const dir = getSnapshotDir();
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
			writeFileSync(join(dir, "plugin-loaded.marker"), `loaded at ${new Date().toISOString()}`, "utf-8");
		} catch (error) {
			console.error(`[${PLUGIN_NAME}] marker setup failed: ${String(error)}`);
		}

		// ── 1. compact-observer: detect compact, write context snapshot ──
		const workspacePath = ctx?.workspacePath ?? process.cwd();

		api.registerMessageBuilder({
			name: "compact-observer",
			build(messages: Message[]) {
				const result = shouldCompact(messages);
				if (result.needsCompact) {
					const tools = collectToolNames(messages);
					const files = collectTouchedFiles(messages);
					console.log(
						`[${PLUGIN_NAME}] compact detected — ` +
						`${result.totalTokens} tokens, ${messages.length} msgs, ` +
						`${tools.length} tools, ${files.length} files.`
					);

					// Write context snapshot (ADR-005: snapshot = windowed compaction artifact)
					const snapshotPath = writeSnapshot(messages, tools, files, workspacePath);
					if (snapshotPath) {
						console.log(`[${PLUGIN_NAME}] snapshot written: ${snapshotPath}`);
					}
				}
				return messages;
			},
		});

		// ── 2. rules injection: dynamic snapshot context for new sessions ──
		//    content is a function — called each time the rule is evaluated.
		//    setup() runs once, but the function re-reads the latest snapshot.
		api.registerRule({
			name: "snapshot-context",
			content: () => buildSnapshotRuleContent(workspacePath),
		});

		// ── 2b. loop-guard rule: dynamic warning injection via system prompt ──
		//    V6 path: bypasses message codec entirely (rules → system prompt).
		//    afterTool detects repetition → writes loopState → this rule reads it.
		api.registerRule({
			name: "loop-guard",
			content: () => {
				if (!loopState.repeating) return "";
				if (loopState.warningCount >= MAX_LOOP_WARNINGS) {
					return ""; // Fallback: defer to Cline max iterations
				}
				return (
					`\n\n## ⚠️ LOOP GUARD WARNING\n` +
					`The tool pattern [${loopState.pattern.join(" → ")}] has repeated ${loopState.count} times.\n` +
					`STOP repeating this pattern. Try a different approach or ask the user for help.\n`
				);
			},
		});

		// ── 3. hooks: tool-call-recorder (beforeTool + afterTool) ──
		//    Unified data source for #1 (slow call detection) and #4 (loop guard).
		//    Hooks are registered via the plugin.hooks field, not api.

		console.log(`[${PLUGIN_NAME}] setup() done — capabilities: messageBuilders, rules, hooks`);
	},

	// ── Hooks (registered on plugin object, not via api) ──
	hooks: {
		beforeTool(args: { toolName: string; input: Record<string, unknown> }) {
			toolRecorder.beforeTool(args.toolName, args.input);
		},

		afterTool(args: { toolName: string; success: boolean }) {
			const record = toolRecorder.afterTool(args.toolName, args.success);
			if (!record) return;

			// #1: Slow call detection
			if (record.duration > 30_000) {
				console.warn(
					`[${PLUGIN_NAME}] SLOW TOOL: ${record.name} took ${(record.duration / 1000).toFixed(1)}s`
				);
			}

			// #4 V6: Repetition detection → update shared loopState
			const rep = toolRecorder.detectRepetition(LOOP_WINDOW, LOOP_THRESHOLD);
			if (rep.repeating) {
				loopState.repeating = true;
				loopState.pattern = rep.pattern;
				loopState.count = rep.count;
				loopState.warningCount++;
				console.warn(
					`[${PLUGIN_NAME}] LOOP DETECTED: pattern [${rep.pattern.join(" → ")}] repeated ${rep.count}x ` +
					`(warning ${loopState.warningCount}/${MAX_LOOP_WARNINGS})`
				);
			} else {
				// Reset when pattern breaks
				loopState.repeating = false;
				loopState.pattern = [];
				loopState.count = 0;
				loopState.warningCount = 0;
			}
		},
	},
};

export default plugin;

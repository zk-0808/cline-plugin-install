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
let loopWarningCount = 0;
const MAX_LOOP_WARNINGS = 3;

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

			// #4: Repetition detection (data collection; injection happens in beforeModel)
			const rep = toolRecorder.detectRepetition(5, 3);
			if (rep.repeating) {
				console.warn(
					`[${PLUGIN_NAME}] LOOP DETECTED: pattern [${rep.pattern.join(" → ")}] repeated ${rep.count}x`
				);
			}
		},

		// #4: beforeModel — inject loop warning into messages before provider call
		// Called every turn before the model request. If repetition is detected,
		// appends a user message with the warning so the model can break the loop.
		// Fallback: after MAX_LOOP_WARNINGS, stop injecting and let Cline max iterations handle it.
		async beforeModel(ctx: { snapshot: any; request: any }) {
			const rep = toolRecorder.detectRepetition(5, 3);
			if (!rep.repeating) {
				// Reset counter when no repetition detected
				loopWarningCount = 0;
				return undefined;
			}

			// Fallback: plugin cannot fix persistent loops — let Cline handle it
			if (loopWarningCount >= MAX_LOOP_WARNINGS) {
				console.warn(
					`[${PLUGIN_NAME}] loop guard fallback: ${loopWarningCount} warnings injected, ` +
					`deferring to Cline max iterations.`
				);
				return undefined;
			}

			const warningText =
				`[${PLUGIN_NAME}] ⚠️ LOOP DETECTED: The tool pattern ` +
				`[${rep.pattern.join(" → ")}] has repeated ${rep.count} times in a row. ` +
				`STOP repeating this pattern. Try a different approach or ask the user for help.`;

			// Use meta marker to avoid false positives from natural user messages
			const META_MARKER = "__plugin_loop_warning__";
			const messages = ctx.request.messages;
			if (messages.length > 0) {
				const last = messages[messages.length - 1];
				if (last.role === "user" && Array.isArray(last.content)) {
					const hasMarker = last.content.some(
						(block: any) => block.type === "text" && typeof block.text === "string" && block.text.includes(META_MARKER)
					);
					if (hasMarker) {
						return undefined; // Already warned in last turn
					}
				}
			}

			loopWarningCount++;
			console.log(`[${PLUGIN_NAME}] beforeModel: injecting loop warning (${loopWarningCount}/${MAX_LOOP_WARNINGS})`);
			return {
				messages: [...messages, {
					role: "user",
					content: [{ type: "text", text: `${META_MARKER}\n${warningText}` }]
				}],
			};
		},
	},
};

export default plugin;

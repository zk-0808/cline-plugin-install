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

// ── V6: Loop Guard shared state (afterTool → messageBuilder bridge) ──
// afterTool detects repetition and writes loopState; messageBuilder reads it.
// Warnings go through conversation messages, not registerRule (evaluated once in CLI 3.0.34).
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
const LOOP_WINDOW = 3;
const LOOP_THRESHOLD = 2;

export const plugin = {
	name: PLUGIN_NAME,
	manifest: {
		capabilities: ["messageBuilders", "rules", "hooks"],
	},

	setup(api: any, ctx?: any) {
		console.log(`[${PLUGIN_NAME}] setup() called`);

		// ── Marker file (plugin health check) ──
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
		// Contract: PluginSetupContext.workspaceInfo.rootPath (not ctx.workspacePath)
		// See @cline/shared/dist/extensions/contribution-registry.d.ts:117-152
		const workspacePath = ctx?.workspaceInfo?.rootPath ?? process.cwd();

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

		// ── 1b. loop-guard-injector: inject warning into conversation context ──
		//    registerMessageBuilder is called every model request (verified CLI 3.0.34).
		//    Replaces registerRule dynamic content path (only evaluated once at session start).
		//    Content uses ContentBlock[] format to avoid §1.15 codec bug (string content).
		api.registerMessageBuilder({
			name: "loop-guard-injector",
			build(messages: Message[]) {
				if (!loopState.repeating) return messages;
				if (loopState.warningCount >= MAX_LOOP_WARNINGS) return messages;

				loopState.warningCount++;
				const warningText =
					`## ⚠️ LOOP GUARD WARNING\n` +
					`The tool pattern [${loopState.pattern.join(" → ")}] has repeated ${loopState.count} times.\n` +
					`STOP repeating this pattern. Try a different approach or ask the user for help.`;

				const warningMsg: Message = {
					role: "user",
					content: [{ type: "text", text: warningText }],
				};
				return [...messages, warningMsg];
			},
		});

		// ── 2. rules injection: snapshot context for new sessions ──
		//    Note: registerRule content is evaluated once at session start in CLI 3.0.34,
		//    so it is only suitable for static content (snapshot context), not dynamic warnings.
		api.registerRule({
			id: "snapshot-context",
			content: () => buildSnapshotRuleContent(workspacePath),
		});

		console.log(`[${PLUGIN_NAME}] setup() done — capabilities: messageBuilders, rules, hooks`);
	},

	// ── Hooks (registered on plugin object, not via api) ──
	// Contract: AgentRuntimeHooks — each hook receives a single `context` object.
	//   beforeTool(context: AgentBeforeToolContext)
	//     - context.toolCall.toolName  (NOT args.toolName)
	//     - context.input
	//   afterTool(context: AgentAfterToolContext)
	//     - context.toolCall.toolName
	//     - context.result.isError     (NOT args.success; success = !isError)
	//     - context.durationMs         (provided by Cline, do not compute)
	// See @cline/shared/dist/agent.d.ts:204-226, 238-247
	hooks: {
		beforeTool(context: any) {
			const toolName = context?.toolCall?.toolName ?? "(unknown)";
			const input = context?.input ?? {};
			toolRecorder.beforeTool(toolName, input);
		},

		afterTool(context: any) {
			const toolName = context?.toolCall?.toolName ?? "(unknown)";
			const isError = context?.result?.isError ?? false;
			const success = !isError;

			const record = toolRecorder.afterTool(toolName, success);
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

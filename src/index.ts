import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "./types";
import { collectToolNames, collectTouchedFiles } from "./compaction";
import { ToolCallRecorder } from "./tool-recorder";
import { buildSnapshotRuleContent } from "./rules-injector";
import { writeSnapshot } from "./snapshot-writer";
import { PLUGIN_NAME, getSnapshotDir } from "./constants";

// ─── Plugin Entry ───

const toolRecorder = new ToolCallRecorder();

// ─── thin-adapter-layer（阶段 2）：messageBuilder + beforeModel 协作 ───
// 方案 E + 方案 A 组合（见 docs/decisions/thin-adapter-layer-design.md §4.2-4.3）
//   1. messageBuilder "snapshot-source-saver"：compaction 前保存完整 messages
//   2. beforeModel hook：检测长度突变 → 用保存的完整 messages 抽 semantic object + 写 snapshot
// 元原则合规：不重造触发逻辑（用长度突变检测原生 condense，不用 token 阈值判断）
let lastFullMessages: Message[] | null = null;
let pluginWorkspacePath: string = process.cwd();

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

		// ── 1. snapshot-source-saver: 保存 compaction 前的完整 messages ──
		// thin-adapter-layer 阶段 2：messageBuilder 在 compaction 前执行（见 custom-compaction 源码注释）
		// 只保存 messages，不检测 condense，不写 snapshot——触发逻辑在 beforeModel hook
		pluginWorkspacePath = ctx?.workspaceInfo?.rootPath ?? process.cwd();

		api.registerMessageBuilder({
			name: "snapshot-source-saver",
			build(messages: Message[]) {
				// 保存完整 messages（compaction 前）供 beforeModel 检测 compaction 后使用
				lastFullMessages = messages;
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
			content: () => buildSnapshotRuleContent(pluginWorkspacePath),
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

		// ── thin-adapter-layer 阶段 2：beforeModel 检测原生 condense + 写 snapshot ──
		// 时序（C 子代理 Verified, agent-runtime.ts:805-807）：prepareTurn(compaction) → beforeModel
		// beforeModel 拿到 compaction 后的 messages，用长度突变检测（方案 A）判断 compaction 是否发生
		// 若发生，用 lastFullMessages（compaction 前完整对话）抽 semantic object + 写 snapshot
		beforeModel(context: any) {
			const currentMessages: Message[] = context?.request?.messages ?? [];

			// 长度突变检测（方案 A）：compaction 后 messages 长度骤减
			if (lastFullMessages &&
				lastFullMessages.length > 4 &&
				currentMessages.length < lastFullMessages.length * 0.5) {
				// compaction 发生——用保存的完整 messages 抽 semantic object + 写 snapshot
				const tools = collectToolNames(lastFullMessages);
				const files = collectTouchedFiles(lastFullMessages);
				console.log(
					`[${PLUGIN_NAME}] compaction detected — ` +
					`${lastFullMessages.length} msgs (pre) → ${currentMessages.length} msgs (post), ` +
					`${tools.length} tools, ${files.length} files.`
				);

				const snapshotPath = writeSnapshot(lastFullMessages, tools, files, pluginWorkspacePath);
				if (snapshotPath) {
					console.log(`[${PLUGIN_NAME}] snapshot written: ${snapshotPath}`);
				}

				// 重置，避免重复触发
				lastFullMessages = null;
			}
			return undefined; // 不修改 messages（codec bug 规避：返回 undefined 不触发 content.map）
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

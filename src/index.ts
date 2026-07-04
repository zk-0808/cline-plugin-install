import { existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "./types";
import { collectToolNames, collectTouchedFiles } from "./compaction";
import { ToolCallRecorder } from "./tool-recorder";
import { buildSnapshotRuleContent } from "./rules-injector";
import { writeSnapshot } from "./snapshot-writer";
import { HandoffProvider } from "./providers/handoff-provider";
import { GitStatusChecker } from "./git-status-checker";
import { PLUGIN_NAME, getSnapshotDir } from "./constants";

// ─── Plugin Entry ───

const toolRecorder = new ToolCallRecorder();

// ─── Debug logger (file-based, survives TUI console suppression) ───
function dbgLog(msg: string) {
	try {
		const dir = getSnapshotDir();
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, "handoff-inject-debug.log"), `[${new Date().toISOString()}] ${msg}\n`, "utf-8");
	} catch { /* ignore */ }
}

// ─── thin-adapter-layer（阶段 2）：messageBuilder + beforeModel 协作 ───
// 方案 E + 方案 A 组合（见 docs/decisions/thin-adapter-layer-design.md §4.2-4.3）
//   1. messageBuilder "snapshot-source-saver"：compaction 前保存完整 messages
//   2. beforeModel hook：检测长度突变 → 用保存的完整 messages 抽 semantic object + 写 snapshot
// 元原则合规：不重造触发逻辑（用长度突变检测原生 condense，不用 token 阈值判断）
let lastFullMessages: Message[] | null = null;
let pluginWorkspacePath: string = process.cwd();

// ─── #6 Continue Previous Project: beforeRun + messageBuilder 协作 ───
// 契约约束（Phase 0 验证, agent.d.ts L239）：
//   - beforeRun 返回 AgentStopControl，不能注入 messages
//   - 必须走"beforeRun 写 module state + messageBuilder 读取注入"模式（方式 B）
// 注入策略：第一次 build() 注入后设标志位，后续不重复注入（YAGNI，compaction 后丢失暂不处理）
interface HandoffState {
	loaded: boolean;
	summary: string;
	content: string;
}
let handoffState: HandoffState | null = null;
let handoffInjected = false;
const handoffProvider = new HandoffProvider();

// ─── #25 commit 守卫: beforeTool 检测未 commit 文件数 ───
// 契约（Phase 0 验证, agent.d.ts L210-216）：
//   - beforeTool 返回 AgentBeforeToolResult = { skip?, stop?, reason?, input?, policy? }
//   - skip: true 跳过本次工具调用（run 继续）
// 性能约束：每 N 次工具调用检查一次（避免每 turn 跑 git status）
// 降级：git 不在 PATH / 非 git repo / git 命令失败 → 不阻断
const gitChecker = new GitStatusChecker();
const UNCOMMITTED_THRESHOLD = 5;
const GIT_CHECK_INTERVAL = 3; // 每 3 次工具调用检查一次
let toolCallCount = 0;
// 写入类工具名集合（只在这些工具后检查，降低开销）
const WRITE_TOOL_NAMES = new Set([
	"write_to_file",
	"replace_in_file",
	"execute_command",
	"insert_content",
	"search_and_replace",
]);

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
		dbgLog(`setup() called, ctx keys=${ctx ? Object.keys(ctx).join(",") : "none"}`);

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
		dbgLog(`setup() pluginWorkspacePath=${pluginWorkspacePath}`);

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

		// ── 1c. handoff-injector: #6 Continue Previous Project ──
		//    beforeRun hook 加载 handoff.md → 写 handoffState
		//    本 messageBuilder 读取 handoffState → 第一次 build() 时注入到 messages
		//    注入格式：ContentBlock[] （codec bug 规避，project-rules-thin-adapter §5）
		api.registerMessageBuilder({
			name: "handoff-injector",
			build(messages: Message[]) {
				dbgLog(`handoff-injector.build() called, handoffState=${handoffState ? "set" : "null"}, handoffInjected=${handoffInjected}, msgs.len=${messages.length}`);
				if (!handoffState || handoffInjected) return messages;

				handoffInjected = true;
				const injectText =
					`## Project State (auto-loaded by beforeRun hook)\n\n` +
					`${handoffState.summary}\n\n` +
					`---\n\n` +
					`${handoffState.content}`;

				const injectMsg: Message = {
					role: "user",
					content: [{ type: "text", text: injectText }],
				};
				dbgLog(`handoff-injector INJECTED, injectText.len=${injectText.length}`);
				return [...messages, injectMsg];
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
		// ── #6 beforeRun: 加载 handoff.md → 写 module state ──
		// 契约（Phase 0 验证, agent.d.ts L239）：
		//   - context: AgentRunLifecycleContext = { snapshot }（无 workspacePath）
		//   - 返回: AgentStopControl = { stop?, reason? }（不能注入 messages）
		//   - workspacePath 用 setup() 时闭包捕获的 pluginWorkspacePath
		beforeRun(_context: any) {
			dbgLog(`beforeRun called, handoffState=${handoffState ? "set" : "null"}, workspacePath=${pluginWorkspacePath}`);
			if (handoffState) {
				// 已加载（CLI 3.0.34 双重 setup() 时可能重复触发）
				dbgLog(`beforeRun: handoffState already set, skipping`);
				return undefined;
			}
			const result = handoffProvider.load(pluginWorkspacePath);
			dbgLog(`beforeRun: load() detected=${result.detected}, content.len=${result.content.length}`);
			if (result.detected) {
				handoffState = {
					loaded: true,
					summary: result.summary,
					content: result.content,
				};
				console.log(`[${PLUGIN_NAME}] handoff loaded:\n${result.summary}`);
				dbgLog(`beforeRun: handoffState set, summary.len=${result.summary.length}`);
			} else {
				console.log(`[${PLUGIN_NAME}] no handoff.md found at ${pluginWorkspacePath}`);
				dbgLog(`beforeRun: no handoff.md found`);
			}
			return undefined; // 不停止 run
		},

		beforeTool(context: any) {
			const toolName = context?.toolCall?.toolName ?? "(unknown)";
			const input = context?.input ?? {};

			// ── #25 commit 守卫 ──
			// 只在写入类工具调用时检查，且每 GIT_CHECK_INTERVAL 次检查一次
			if (WRITE_TOOL_NAMES.has(toolName)) {
				toolCallCount++;
				if (toolCallCount % GIT_CHECK_INTERVAL === 0) {
					const gitResult = gitChecker.countUncommitted(pluginWorkspacePath);
					if (
						gitResult.isRepo &&
						gitResult.uncommittedCount >= UNCOMMITTED_THRESHOLD
					) {
						const reason =
							`未 commit 文件 ≥ ${UNCOMMITTED_THRESHOLD}（当前 ${gitResult.uncommittedCount} 个）。` +
							`请先写 handoff + commit，再继续工具调用。` +
							`(tool=${toolName}, skipped by #25 commit guard)`;
						console.warn(`[${PLUGIN_NAME}] COMMIT GUARD: ${reason}`);
						return { skip: true, reason };
					}
				}
			}

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

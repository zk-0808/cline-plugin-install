import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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

// ─── thin-adapter-layer（阶段 2）：messageBuilder + beforeModel 协作 ───
// 方案 E + 方案 A 组合（见 docs/decisions/thin-adapter-layer-design.md §4.2-4.3）
//   1. messageBuilder "snapshot-source-saver"：compaction 前保存完整 messages
//   2. beforeModel hook：检测长度突变 → 用保存的完整 messages 抽 semantic object + 写 snapshot
// 元原则合规：不重造触发逻辑（用长度突变检测原生 condense，不用 token 阈值判断）
let lastFullMessages: Message[] | null = null;
let pluginWorkspacePath: string = process.cwd();

// ─── #6 Continue Previous Project: registerRule 注入 handoff + snapshot ───
// ADR-007: snapshot 走 registerRule 静态注入（不迁 messageBuilder）
//   - 会话内续命归 cline 原生 compaction，snapshot 只服务跨会话续作
//   - registerRule content 只在 session 启动求值一次，匹配 snapshot/handoff 静态资产语义
//   - content() 改纯函数读预加载 state，I/O 在 setup() 完成（可单测）
//   - 复查触发：若需本会话重读自己中途写的 snapshot，本定位失效（见 ADR-007 §4）
const handoffProvider = new HandoffProvider();
// 预加载 state（setup() 时加载，content() 只读）——ADR-007 §5.1
let handoffContentLoaded = "";
let snapshotContentLoaded = "";

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

		// ── 2. rules injection: handoff + snapshot 各注册一条（ADR-007 拆分） ──
		// ADR-007: 两者都是 session-start 静态资产，registerRule "求值一次" 契约匹配
		// content() 是纯函数（读预加载 state，无 I/O），可单测
		// 独立降级：加载失败 → content 返回空字符串，不影响另一条 rule
		// 2a. 预加载（I/O 在 setup 完成，content 只读）——ADR-007 §5.1
		try {
			snapshotContentLoaded = buildSnapshotRuleContent(pluginWorkspacePath);
		} catch (error) {
			console.error(`[${PLUGIN_NAME}] snapshot preload failed: ${String(error)}`);
			snapshotContentLoaded = "";
		}
		try {
			const handoffResult = handoffProvider.load(pluginWorkspacePath);
			handoffContentLoaded = handoffResult.detected
				? `# PROJECT HANDOFF (AUTO-INJECTED — DO NOT RE-READ handoff.md)\n\n` +
					`The following is the project handoff state, auto-loaded by context-snapshot plugin.\n` +
					`When answering questions about project state, recent commits, todos, or blockers:\n` +
					`1. USE the information below DIRECTLY — do NOT call run_commands (git log) or read_files (handoff.md)\n` +
					`2. If the user asks for "latest commit hash", quote it from the "Git 提交" section below\n` +
					`3. If the user asks for "P0 todo", quote it from the "待办" section below\n` +
					`4. Only call tools if the requested information is NOT in the handoff below\n\n` +
					`--- HANDOFF START ---\n` +
					`${handoffResult.summary}\n\n` +
					`---\n\n` +
					`${handoffResult.content}\n` +
					`--- HANDOFF END ---`
				: "";
		} catch (error) {
			console.error(`[${PLUGIN_NAME}] handoff preload failed: ${String(error)}`);
			handoffContentLoaded = "";
		}

		// 2b. snapshot-context rule（只注入 snapshot）
		api.registerRule({
			id: "snapshot-context",
			content: () => snapshotContentLoaded,
		});

		// 2c. handoff-context rule（只注入 handoff）
		api.registerRule({
			id: "handoff-context",
			content: () => handoffContentLoaded,
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

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// ─── #6 Continue Previous Project: handoff.md provider ───
// beforeRun 调用 load() → 写 module state → messageBuilder "handoff-injector" 注入
// 契约约束（Phase 0 验证）：
//   - beforeRun context 无 workspacePath（AgentRunLifecycleContext 只有 snapshot）
//   - workspacePath 须 setup() 时从 ctx.workspaceInfo.rootPath 闭包捕获
//   - beforeRun 返回 AgentStopControl，不能注入 messages → 必须走 module state + messageBuilder

/** Provider 加载结果 — detect 失败时 detected=false，其余字段为空 */
export interface ProviderResult {
	detected: boolean;
	/** 给用户的通知（简短，console.log 用） */
	summary: string;
	/** 注入到 context 的内容（完整或截断） */
	content: string;
}

/**
 * HandoffProvider — 检测 + 加载 docs/handoff.md
 *
 * 设计原则（hook-auto-injection-design.md §3.3）：
 *   - detect / load / summarize 三职责分离
 *   - 不解析 handoff 结构（避免与 handoff-schema 耦合）
 *   - 直接注入全文截断（YAGNI）
 */
export class HandoffProvider {
	private static readonly HANDOFF_REL_PATH = "docs/handoff.md";
	private static readonly MAX_CONTENT_CHARS = 4000;

	detect(workspacePath: string): boolean {
		return existsSync(join(workspacePath, HandoffProvider.HANDOFF_REL_PATH));
	}

	load(workspacePath: string): ProviderResult {
		const fullPath = join(workspacePath, HandoffProvider.HANDOFF_REL_PATH);
		if (!this.detect(workspacePath)) {
			return { detected: false, summary: "", content: "" };
		}

		const stat = statSync(fullPath);
		const content = readFileSync(fullPath, "utf-8");
		const updated = stat.mtime.toISOString().replace("T", " ").slice(0, 16);

		// 粗略统计未完成项（匹配表格行中的优先级 emoji）
		const unfinishedMatch = content.match(/[🟡🟢🔴]\s*(中|低|高)/g);
		const unfinishedCount = unfinishedMatch ? unfinishedMatch.length : 0;

		const summary =
			`✓ 检测到 handoff.md（最近更新: ${updated}）\n` +
			`✓ 发现 ${unfinishedCount} 个未完成事项`;

		const truncated =
			content.length > HandoffProvider.MAX_CONTENT_CHARS
				? content.slice(0, HandoffProvider.MAX_CONTENT_CHARS) +
					"\n\n... [truncated — see full handoff.md]"
				: content;

		return {
			detected: true,
			summary,
			content: truncated,
		};
	}
}

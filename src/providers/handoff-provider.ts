import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// ─── #6 Continue Previous Project: handoff.md provider ───
// setup() 预加载 I/O → module state → content() 纯函数读 state → registerRule("handoff-context") 注入
// 契约约束（ADR-007）：
//   - registerRule content 只在 session 启动求值一次，匹配 handoff 静态资产语义
//   - I/O 在 setup() 完成，content() 只读 state，可单测
//   - workspacePath 须 setup() 时从 ctx.workspaceInfo.rootPath 闭包捕获

/** Provider 加载结果 — detect 失败时 detected=false，其余字段为空 */
export interface ProviderResult {
	detected: boolean;
	/** 给用户的通知（简短，console.log 用） */
	summary: string;
	/** 注入到 context 的内容（完整或截断） */
	content: string;
}

/** P 级待办项提取结果 */
interface PLevelItem {
	id: string;
	title: string;
	status: "已完成" | "部分完成" | "待完成";
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

		const items = this.extractPLevelItems(content);
		const summary = this.buildSummary(updated, items);

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

	/** 从 handoff.md 提取 P 级待办项（匹配 ## P\d+ 标题） */
	private extractPLevelItems(content: string): PLevelItem[] {
		const items: PLevelItem[] = [];
		// 匹配 ## P1 — 标题 / ### P2 — 标题 等（二级或三级标题）
		const headerRegex = /^##+?\s+(P\d+)\s*[—\-–]\s*(.+)$/gm;
		let match: RegExpExecArray | null;

		while ((match = headerRegex.exec(content)) !== null) {
			const id = match[1];
			const title = match[2].trim();
			const startIdx = match.index + match[0].length;
			// 截取到下一个任意级别 heading 或文件末尾
			const nextHeaderMatch = /\n##+?\s/.exec(content.slice(startIdx));
			const sectionEnd = nextHeaderMatch ? startIdx + nextHeaderMatch.index : content.length;
			const section = content.slice(startIdx, sectionEnd);

			let status: PLevelItem["status"] = "待完成";
			if (/已完成/.test(section) && !/待完成/.test(section)) {
				status = "已完成";
			} else if (/已完成/.test(section) && /待完成/.test(section)) {
				status = "部分完成";
			}

			items.push({ id, title, status });
		}

		return items;
	}

	private buildSummary(updated: string, items: PLevelItem[]): string {
		const lines = [`✓ 检测到 handoff.md（最近更新: ${updated}）`];

		if (items.length === 0) {
			lines.push("✓ 无 P 级待办项");
		} else {
			const pending = items.filter((i) => i.status !== "已完成");
			lines.push(`✓ ${items.length} 个 P 级项（${pending.length} 个未完成）：`);
			for (const item of items) {
				const marker = item.status === "已完成" ? "✅" : item.status === "部分完成" ? "⏳" : "🔲";
				lines.push(`  ${marker} ${item.id}: ${item.title} [${item.status}]`);
			}
		}

		return lines.join("\n");
	}
}

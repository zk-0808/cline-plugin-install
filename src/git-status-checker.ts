import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// ─── #25 commit 守卫: beforeTool 检测未 commit 文件数 ───
// 契约（Phase 0 验证, agent.d.ts L210-216）：
//   - beforeTool 返回 AgentBeforeToolResult = { skip?, stop?, reason?, input?, policy? }
//   - skip: true → 跳过本次工具调用（run 继续）
//   - 用于 commit 守卫：未 commit ≥ 阈值 → skip + reason

/** Git 状态检查结果 */
export interface GitStatusResult {
	/** 是否为 git repo */
	isRepo: boolean;
	/** 未 commit 文件数（-1 表示 git 不可用） */
	uncommittedCount: number;
	/** 错误信息（git 不可用时填充） */
	error?: string;
}

export class GitStatusChecker {
	private static readonly GIT_CMD = "git status --porcelain";
	private static readonly GIT_DIR = ".git";

	/** 检测 workspace 是否为 git repo */
	isGitRepo(workspacePath: string): boolean {
		return existsSync(join(workspacePath, GitStatusChecker.GIT_DIR));
	}

	/**
	 * 统计未 commit 文件数
	 * 降级策略：
	 *   - workspace 不是 git repo → isRepo=false, 不阻断
	 *   - git 命令执行失败 → uncommittedCount=-1, 不阻断（避免误杀）
	 */
	countUncommitted(workspacePath: string): GitStatusResult {
		if (!this.isGitRepo(workspacePath)) {
			return { isRepo: false, uncommittedCount: 0 };
		}

		try {
			const output = execSync(GitStatusChecker.GIT_CMD, {
				cwd: workspacePath,
				encoding: "utf-8",
				timeout: 5000,
				stdio: ["pipe", "pipe", "pipe"],
			});
			const lines = output.trim().split("\n").filter((l) => l.length > 0);
			return { isRepo: true, uncommittedCount: lines.length };
		} catch (error) {
			// git 不在 PATH 或其他错误 → 降级，不阻断
			return {
				isRepo: true,
				uncommittedCount: -1,
				error: String(error).slice(0, 200),
			};
		}
	}
}

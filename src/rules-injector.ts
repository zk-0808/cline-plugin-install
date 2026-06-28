import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

const HANDOFF_DIR = join(homedir(), ".cline", "data", "handoff");

/** Compute a 4-char hash of the workspace path for file naming */
export function projectHash(workspacePath: string): string {
	return createHash("sha256").update(workspacePath).digest("hex").slice(0, 4);
}

/** Generate a handoff filename: {project}-{timestamp}-{uuid}.md */
export function handoffFilename(workspacePath: string): string {
	const hash = projectHash(workspacePath);
	const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const uuid = Math.random().toString(36).slice(2, 8);
	return `${hash}-${ts}-${uuid}.md`;
}

/**
 * Find the latest handoff file for the current project.
 * Matches by project hash prefix, then sorts by timestamp.
 */
export function findLatestHandoff(workspacePath: string): string | null {
	if (!existsSync(HANDOFF_DIR)) return null;

	const hash = projectHash(workspacePath);
	const files = readdirSync(HANDOFF_DIR)
		.filter((f) => f.startsWith(`${hash}-`) && f.endsWith(".md"))
		.map((f) => ({
			name: f,
			path: join(HANDOFF_DIR, f),
			mtime: statSync(join(HANDOFF_DIR, f)).mtimeMs,
		}))
		.sort((a, b) => b.mtime - a.mtime);

	return files.length > 0 ? files[0].path : null;
}

/**
 * Build the rule content string for handoff injection.
 * Returns empty string if no handoff found (rule will be invisible).
 */
export function buildHandoffRuleContent(workspacePath: string): string {
	const handoffPath = findLatestHandoff(workspacePath);
	if (!handoffPath) return "";

	try {
		const content = readFileSync(handoffPath, "utf-8");
		// Truncate to avoid blowing up context — keep first 2000 chars
		const truncated = content.length > 2000
			? content.slice(0, 2000) + "\n\n... [truncated — see full handoff.md]"
			: content;

		return [
			"## Previous Session Context (auto-injected)",
			"",
			"The following is the most recent handoff from a previous session.",
			"Use it to understand what was done, what decisions were made, and what to continue.",
			"",
			truncated,
		].join("\n");
	} catch {
		return "";
	}
}

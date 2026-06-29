import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { PLUGIN_NAME, getSnapshotDir } from "./constants";

/** Compute a 4-char hash of the workspace path for file naming */
export function projectHash(workspacePath: string): string {
	return createHash("sha256").update(workspacePath).digest("hex").slice(0, 4);
}

/** Generate a snapshot filename: {project}-{timestamp}-{uuid}.md */
export function snapshotFilename(workspacePath: string): string {
	const hash = projectHash(workspacePath);
	const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const uuid = Math.random().toString(36).slice(2, 8);
	return `${hash}-${ts}-${uuid}.md`;
}

/**
 * Find the latest snapshot file for the current project.
 * Matches by project hash prefix, then sorts by mtime.
 */
export function findLatestSnapshot(workspacePath: string): string | null {
	const dir = getSnapshotDir();
	if (!existsSync(dir)) return null;

	const hash = projectHash(workspacePath);
	const files = readdirSync(dir)
		.filter((f) => f.startsWith(`${hash}-`) && f.endsWith(".md"))
		.map((f) => ({
			name: f,
			path: join(dir, f),
			mtime: statSync(join(dir, f)).mtimeMs,
		}))
		.sort((a, b) => b.mtime - a.mtime);

	return files.length > 0 ? files[0].path : null;
}

/**
 * Build the rule content string for snapshot injection.
 * Returns empty string if no snapshot found (rule will be invisible).
 */
export function buildSnapshotRuleContent(workspacePath: string): string {
	const snapshotPath = findLatestSnapshot(workspacePath);
	if (!snapshotPath) return "";

	try {
		const content = readFileSync(snapshotPath, "utf-8");
		// Truncate to avoid blowing up context — keep first 2000 chars
		const truncated = content.length > 2000
			? content.slice(0, 2000) + "\n\n... [truncated — see full snapshot file]"
			: content;

		return [
			"## Previous Session Context (auto-injected)",
			"",
			"The following is the most recent context snapshot from a previous session.",
			"Use it to understand what was done, what decisions were made, and what to continue.",
			"",
			truncated,
		].join("\n");
	} catch (error) {
		console.error(`[${PLUGIN_NAME}] rule read failed: ${String(error)}`);
		return "";
	}
}

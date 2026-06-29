import { join } from "node:path";
import { homedir } from "node:os";

/** Plugin name — used as log prefix across all modules */
export const PLUGIN_NAME = "context-snapshot";

/** Global snapshot storage directory */
export function getSnapshotDir(): string {
	return join(homedir(), ".cline", "data", "snapshot");
}

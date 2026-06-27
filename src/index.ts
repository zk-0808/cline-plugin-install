import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const dir = path.join(os.homedir(), ".cline", "data", "handoff");
try {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "plugin-loaded.marker"), JSON.stringify({
		loaded: true,
		timestamp: new Date().toISOString(),
	}), "utf-8");
} catch {
}

export const plugin = {
	name: "auto-handoff",
	manifest: {
		capabilities: ["messageBuilders"],
	},
	setup(api) {
		api.registerMessageBuilder({
			name: "detect-compact",
			build(messages) {
				return messages;
			},
		});
	},
};

export default plugin;

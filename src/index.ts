const PLUGIN_NAME = "auto-handoff";

export const plugin = {
	name: PLUGIN_NAME,
	manifest: {
		capabilities: ["messageBuilders"],
	},

	setup(api) {
		console.log(`[${PLUGIN_NAME}] setup() called`);

		api.registerMessageBuilder({
			name: "detect-compact",
			build(messages) {
				console.log(`[${PLUGIN_NAME}] build() called with ${messages.length} messages`);
				return messages;
			},
		});

		console.log(`[${PLUGIN_NAME}] setup() completed`);
	},
};

export default plugin;

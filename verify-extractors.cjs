/**
 * A4 Phase 4 — Extractor Precision/Recall Verification
 * Run: node verify-extractors.cjs
 */
const { extractSnapshotData } = require("./dist/snapshot-writer.js");

// ─── Helper ───
function msg(role, content) { return { role, content }; }
function msgBlocks(role, blocks) { return { role, content: blocks }; }

// ─── Scenario 1: EN explicit decisions ───
const s1 = [
	msg("user", "Let's adopt the new compaction algorithm for v0.7.0."),
	msg("assistant", "I've implemented the new compaction algorithm."),
	msg("user", "Good. Accept the ContentBlock[] format for message content."),
	msg("assistant", "Updated content format to ContentBlock[]."),
	msg("user", "Reject the symlink approach for plugin install. Use copy instead."),
	msg("assistant", "Switched to copy-based install."),
	msg("user", "Let's defer the SDK migration to next quarter."),
	msg("assistant", "Noted, SDK migration deferred."),
	msg("user", "Roll back the window parameter from 5 to 3."),
	msg("assistant", "Rolled back window=3."),
	msgBlocks("assistant", [
		{ type: "tool_use", id: "tc1", name: "write_file", input: { path: "src/index.ts", content: "..." } },
	]),
	msg("user", "The design doc is at https://example.com/design.md, please reference it."),
];
const s1gt = { decisions: [
	{ keyword: "adopt", status: "accepted" },
	{ keyword: "accept", status: "accepted" },
	{ keyword: "reject", status: "rejected" },
	{ keyword: "defer", status: "deferred" },
	{ keyword: "roll back", status: "rolled-back" },
]};

// ─── Scenario 2: CN assistant decisions ───
const s2 = [
	msg("user", "请帮我设计一个 Loop Guard 机制"),
	msg("assistant", "已决定采用 registerRule 方案实现 Loop Guard。"),
	msg("user", "好的，开始实现"),
	msg("assistant", "经过测试，确认采用 messageBuilder 路径替代 registerRule。"),
	msg("user", "下一步需要验证提取器精度"),
	msg("assistant", "待跟进：A4 Phase 4 精度验证，优先级紧急。"),
	msg("user", "参见 docs/design.md 和 docs/handoff.md 了解更多设计细节"),
	msgBlocks("assistant", [
		{ type: "file", path: "src/snapshot-writer.ts", content: "// snapshot writer code" },
		{ type: "tool_use", id: "tc2", name: "write_file", input: { path: "src/extractors/decision-extractor.ts" } },
	]),
	msg("user", "https://github.com/cline/cline/issues/11944 是需要跟进的 issue"),
];
const s2gt = { decisions: [
	{ keyword: "已决定", status: "decided" },
	{ keyword: "确认采用", status: "decided" },
]};

// ─── Scenario 3: Mixed minimal ───
const s3 = [
	msg("user", "I approve the new testing strategy."),
	msg("assistant", "Testing strategy approved. I'll start implementation."),
	msg("user", "这个方案还需要讨论"),
	msg("assistant", "好的，我们继续讨论。"),
	msg("user", "Please read the config file"),
	msgBlocks("assistant", [
		{ type: "tool_use", id: "tc3", name: "read_files", input: { files: [{ path: "package.json" }] } },
	]),
	msg("user", "Decline the proposal to use dynamic imports. We stick with static imports."),
	msg("assistant", "Understood. Keeping static imports."),
];
const s3gt = { decisions: [
	{ keyword: "approve", status: "accepted" },
	{ keyword: "decline", status: "rejected" },
]};

// ─── Runner ───
function run(name, messages, gt) {
	console.log(`\n${"═".repeat(60)}`);
	console.log(`  Scenario: ${name}`);
	console.log(`${"═".repeat(60)}`);

	const tools = ["write_file", "read_files"];
	const files = ["src/index.ts", "src/snapshot-writer.ts", "docs/design.md", "docs/handoff.md", "package.json"];
	const snap = extractSnapshotData(messages, tools, files);

	console.log(`\n📊 ${snap.decisions.length} decisions, ${snap.changes.length} changes, ${snap.todos.length} todos, ${snap.sources.length} sources`);

	console.log("\n── Decisions ──");
	for (const d of snap.decisions) {
		console.log(`  [${d.confidence}] ${d.status}: "${d.text.slice(0, 80)}"`);
	}

	// Recall
	let recalled = 0;
	const missed = [];
	for (const g of gt.decisions) {
		const hit = snap.decisions.some(d => d.status === g.status && d.text.toLowerCase().includes(g.keyword.toLowerCase()));
		if (hit) recalled++; else missed.push(`${g.keyword} (${g.status})`);
	}
	const recall = gt.decisions.length > 0 ? recalled / gt.decisions.length : 1;

	// Precision
	let tp = 0;
	const fp = [];
	for (const d of snap.decisions) {
		const genuine = gt.decisions.some(g => d.status === g.status && d.text.toLowerCase().includes(g.keyword.toLowerCase()));
		if (genuine) tp++; else fp.push(`"${d.text.slice(0, 50)}" (${d.status})`);
	}
	const precision = snap.decisions.length > 0 ? tp / snap.decisions.length : 1;

	console.log(`\n── Results ──`);
	console.log(`  Ground truth: ${gt.decisions.length} | Extracted: ${snap.decisions.length}`);
	console.log(`  Recalled: ${recalled}/${gt.decisions.length} = ${(recall * 100).toFixed(0)}%`);
	console.log(`  Precision: ${tp}/${snap.decisions.length} = ${(precision * 100).toFixed(0)}%`);
	if (missed.length) console.log(`  ❌ Missed: ${missed.join(", ")}`);
	if (fp.length) console.log(`  ⚠️  False+: ${fp.join("; ")}`);
	console.log(`  Recall ≥80%: ${recall >= 0.8 ? "✅" : "❌"}  Precision ≥70%: ${precision >= 0.7 ? "✅" : "❌"}`);

	console.log(`\n── Changes (${snap.changes.length}) ──`);
	for (const c of snap.changes) console.log(`  [${c.confidence}] ${c.kind}: ${c.path || c.toolName || "?"}`);
	console.log(`── Todos (${snap.todos.length}) ──`);
	for (const t of snap.todos) console.log(`  [${t.confidence}] ${t.direction} (pri=${t.priority})`);
	console.log(`── Sources (${snap.sources.length}) ──`);
	for (const s of snap.sources) console.log(`  [${s.confidence}] ${s.kind}: ${s.path}`);

	return { recall, precision, passR: recall >= 0.8, passP: precision >= 0.7 };
}

// ─── Main ───
console.log("A4 Phase 4 — Extractor Verification");
console.log(`Node ${process.version}\n`);

const res = [
	run("S1: EN explicit", s1, s1gt),
	run("S2: CN assistant", s2, s2gt),
	run("S3: Mixed minimal", s3, s3gt),
];

console.log(`\n${"═".repeat(60)}`);
console.log("  AGGREGATE");
console.log(`${"═".repeat(60)}`);
const avgR = res.reduce((s, r) => s + r.recall, 0) / res.length;
const avgP = res.reduce((s, r) => s + r.precision, 0) / res.length;
console.log(`  Avg Recall:    ${(avgR * 100).toFixed(0)}% (≥80%)`);
console.log(`  Avg Precision: ${(avgP * 100).toFixed(0)}% (≥70%)`);
const ok = res.every(r => r.passR && r.passP);
console.log(`\n  OVERALL: ${ok ? "✅ A4 PHASE 4 PASSED" : "❌ A4 PHASE 4 FAILED"}`);
process.exit(ok ? 0 : 1);

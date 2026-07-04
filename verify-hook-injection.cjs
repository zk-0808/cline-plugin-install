/**
 * Phase 3 验证 — HandoffProvider + GitStatusChecker 核心逻辑
 * Run: node verify-hook-injection.cjs
 */
const { HandoffProvider } = require("./dist/src/providers/handoff-provider.js");
const { GitStatusChecker } = require("./dist/src/git-status-checker.js");

const WORKSPACE = "e:\\cline++";

console.log("Phase 3 — Hook Injection Verification");
console.log(`Workspace: ${WORKSPACE}\n`);

// ─── Test 1: HandoffProvider ───
console.log(`${"═".repeat(60)}`);
console.log("  Test 1: HandoffProvider");
console.log(`${"═".repeat(60)}`);

const hp = new HandoffProvider();
const detectResult = hp.detect(WORKSPACE);
console.log(`detect(): ${detectResult ? "✅ found" : "❌ not found"}`);

const loadResult = hp.load(WORKSPACE);
console.log(`load().detected: ${loadResult.detected ? "✅" : "❌"}`);
console.log(`load().summary:\n${loadResult.summary}`);
console.log(`load().content length: ${loadResult.content.length} chars`);
console.log(`content preview (first 200): ${loadResult.content.slice(0, 200)}...`);

// ─── Test 2: GitStatusChecker ───
console.log(`\n${"═".repeat(60)}`);
console.log("  Test 2: GitStatusChecker");
console.log(`${"═".repeat(60)}`);

const gc = new GitStatusChecker();
const isRepo = gc.isGitRepo(WORKSPACE);
console.log(`isGitRepo(): ${isRepo ? "✅ yes" : "❌ no"}`);

const gitResult = gc.countUncommitted(WORKSPACE);
console.log(`countUncommitted().isRepo: ${gitResult.isRepo ? "✅" : "❌"}`);
console.log(`countUncommitted().uncommittedCount: ${gitResult.uncommittedCount}`);
if (gitResult.error) console.log(`error: ${gitResult.error}`);

const threshold = 5;
const wouldBlock = gitResult.isRepo && gitResult.uncommittedCount >= threshold;
console.log(`\nWould block (threshold=${threshold}): ${wouldBlock ? "🚫 YES" : "✅ NO"}`);
if (wouldBlock) {
	console.log(`  Reason: 未 commit 文件 ≥ ${threshold}（当前 ${gitResult.uncommittedCount} 个）`);
}

// ─── Test 3: Non-git workspace (降级) ───
console.log(`\n${"═".repeat(60)}`);
console.log("  Test 3: Non-git workspace (降级测试)");
console.log(`${"═".repeat(60)}`);

const nonGit = gc.countUncommitted("C:\\Windows\\System32");
console.log(`isRepo: ${nonGit.isRepo ? "✅" : "❌ (expected)"}`);
console.log(`uncommittedCount: ${nonGit.uncommittedCount} (expected 0)`);
console.log(`Would block: ${nonGit.isRepo && nonGit.uncommittedCount >= threshold ? "🚫" : "✅ NO (降级正确)"}`);

// ─── Summary ───
console.log(`\n${"═".repeat(60)}`);
console.log("  SUMMARY");
console.log(`${"═".repeat(60)}`);
const t1Pass = detectResult && loadResult.detected && loadResult.content.length > 0;
const t2Pass = isRepo && gitResult.isRepo && gitResult.uncommittedCount >= 0;
const t3Pass = !nonGit.isRepo;
console.log(`Test 1 (HandoffProvider): ${t1Pass ? "✅ PASS" : "❌ FAIL"}`);
console.log(`Test 2 (GitStatusChecker): ${t2Pass ? "✅ PASS" : "❌ FAIL"}`);
console.log(`Test 3 (降级): ${t3Pass ? "✅ PASS" : "❌ FAIL"}`);
const allPass = t1Pass && t2Pass && t3Pass;
console.log(`\nOVERALL: ${allPass ? "✅ PHASE 3 LOGIC PASSED" : "❌ PHASE 3 LOGIC FAILED"}`);
console.log(`\n注: beforeRun/beforeTool hook 路由验证需 CLI 集成测试（需用户跑 cline -i）`);
process.exit(allPass ? 0 : 1);

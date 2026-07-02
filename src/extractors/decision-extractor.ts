import type { Message, DecisionRecord, EvidenceRef, Extractor } from "../types";

const DECISION_KEYWORDS = /\b(accept|reject|adopt|defer|roll\s*back|approved?|declined?)\b/i;
const ASSISTANT_DECISION = /(已决定|采纳|拒绝|确认采用|驳回|搁置|回滚)/;

function statusFromKeyword(keyword: string): DecisionRecord["status"] {
	const k = keyword.toLowerCase().trim();
	if (/^(accept|adopt|approve)/.test(k)) return "accepted";
	if (/^(reject|decline)/.test(k)) return "rejected";
	if (/^defer/.test(k)) return "deferred";
	if (/^roll/.test(k)) return "rolled-back";
	return "decided";
}

/**
 * Decision extractor — scans user + assistant messages.
 *
 * v0.7.0 improvements over v0.6.0:
 * - Scans assistant messages (not just user)
 * - Confidence based on signal source + context clarity
 * - EvidenceRef for traceability
 */
const DECISION_SORT: Record<string, number> = { high: 0, medium: 1, low: 2 };

export const decisionExtractor: Extractor<DecisionRecord> = {
	name: "decision-extractor",

	extract(messages: Message[]): DecisionRecord[] {
		const decisions: DecisionRecord[] = [];

		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i];
			const text = typeof msg.content === "string" ? msg.content : "";

			if (msg.role === "user") {
				const match = text.match(DECISION_KEYWORDS);
				if (match) {
					const keyword = match[1];
					const excerpt = text.slice(0, 100).replace(/\n/g, " ").trim();
					const evidence: EvidenceRef = { messageIndex: i, role: "user", excerpt };

					// Check if there's a clear decision object (context from previous messages)
					const hasContext = i > 0 && text.length > keyword.length + 10;
					decisions.push({
						text: excerpt,
						status: statusFromKeyword(keyword),
						confidence: hasContext ? "high" : "low",
						evidence: [evidence],
					});
				}
			} else if (msg.role === "assistant") {
				const match = text.match(ASSISTANT_DECISION);
				if (match) {
					const excerpt = text.slice(0, 100).replace(/\n/g, " ").trim();
					const evidence: EvidenceRef = { messageIndex: i, role: "assistant", excerpt };
					decisions.push({
						text: excerpt,
						status: "decided",
						confidence: "medium",
						evidence: [evidence],
					});
				}
			}
		}

		return decisions.sort((a, b) =>
			(DECISION_SORT[a.confidence] ?? 999) - (DECISION_SORT[b.confidence] ?? 999),
		);
	},
};

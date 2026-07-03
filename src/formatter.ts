// ─── Display Formatters ───
// Centralized label mapping for snapshot rendering.
// Extractors produce semantic values（schema §1.0 状态机词汇 Verified/Likely/Hypothesis），formatters produce display strings.

export const CONFIDENCE_LABELS: Record<string, string> = {
	Verified: "🟢 Verified",
	Likely: "🟡 Likely",
	Hypothesis: "🔴 Hypothesis",
};

export const PRIORITY_LABELS: Record<string, string> = {
	high: "🔴 high",
	medium: "🟡 medium",
	low: "🟢 low",
	tbd: "⚪ tbd",
};

export function formatConfidence(value: string): string {
	return CONFIDENCE_LABELS[value] ?? value;
}

export function formatPriority(value: string): string {
	return PRIORITY_LABELS[value] ?? value;
}

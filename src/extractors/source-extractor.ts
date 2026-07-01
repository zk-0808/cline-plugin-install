import type { Message, SourceRecord, EvidenceRef, Extractor } from "../types";

const URL_PATTERN = /https?:\/\/[^\s)"'<>]+/g;
const DOC_EXTENSIONS = /\.(md|txt|json|yaml|yml)$/i;
const CODE_EXTENSIONS = /\.(ts|js|tsx|jsx|py|rs|go|java|c|cpp|h)$/i;
const CONFIG_FILES = /(package\.json|tsconfig\.json|\.eslintrc|\.prettierrc|\.gitmodules)/i;
const REFERENCE_CONTEXT = /(详见|参见|见|reference|see|source|来源)/i;

/**
 * Source extractor — extracts authoritative source references.
 *
 * v0.7.0 improvements over v0.6.0:
 * - Semantic context判断 (not just file extension)
 * - Distinguishes doc / source-code / config / external
 * - URLs extracted as external sources
 */
export const sourceExtractor: Extractor<SourceRecord> = {
	name: "source-extractor",

	extract(messages: Message[], _tools: string[], files: string[]): SourceRecord[] {
		const sources: SourceRecord[] = [];
		const seen = new Set<string>();

		// Scan messages for URLs and contextual references
		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i];
			const text = typeof msg.content === "string" ? msg.content : "";

			// Extract URLs
			const urls = text.match(URL_PATTERN);
			if (urls) {
				for (const url of urls) {
					if (!seen.has(url)) {
						seen.add(url);
						sources.push({
							path: url,
							kind: "external",
							confidence: "high",
							evidence: [{ messageIndex: i, role: msg.role, excerpt: url.slice(0, 100) }],
						});
					}
				}
			}

			// Check for file references with context
			if (REFERENCE_CONTEXT.test(text)) {
				for (const file of files) {
					if (text.includes(file) && !seen.has(file)) {
						seen.add(file);
						sources.push({
							path: file,
							kind: kindForFile(file),
							confidence: "medium",
							evidence: [{ messageIndex: i, role: msg.role, excerpt: `${file} in reference context` }],
						});
					}
				}
			}
		}

		// Collect remaining files not yet seen
		for (const file of files) {
			if (!seen.has(file)) {
				seen.add(file);
				sources.push({
					path: file,
					kind: kindForFile(file),
					confidence: "low",
					evidence: [{ messageIndex: -1, role: "assistant", excerpt: `file (from summary): ${file}` }],
				});
			}
		}

		return sources;
	},
};

function kindForFile(path: string): SourceRecord["kind"] {
	if (CONFIG_FILES.test(path)) return "config";
	if (CODE_EXTENSIONS.test(path)) return "source-code";
	if (DOC_EXTENSIONS.test(path)) return "doc";
	return "doc";
}

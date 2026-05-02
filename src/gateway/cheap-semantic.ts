import type { GatewayCandidate, GatewayJudgeDecision, RankedGatewayCandidate } from "./types.js";

function normalize(text: string): string {
	return text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function terms(text: string): string[] {
	const raw = normalize(text).match(/[\p{L}\p{N}_.\/-]+/gu) ?? [];
	const out = new Set<string>();
	for (const token of raw) {
		const cleaned = token.replace(/^[-_/.,]+|[-_/.,]+$/g, "");
		if (cleaned.length < 3 && !/[_.\/-\d]/.test(cleaned)) continue;
		out.add(cleaned);
		if (cleaned.length > 4 && cleaned.endsWith("s")) out.add(cleaned.slice(0, -1));
	}
	return [...out];
}

function contentTypeBoost(path: string): number {
	if (path.includes("70-runbooks/")) return 2.2;
	if (path.includes("50-decisions/") || path.includes("30-decisions/")) return 1.8;
	if (path.includes("20-context/")) return 1.5;
	if (path.includes("60-observations/")) return 1.2;
	return 1;
}

function candidateText(candidate: GatewayCandidate): string {
	return normalize(`${candidate.path}\n${candidate.content}`);
}

export function contextualAnchors(prompt: string, candidates: GatewayCandidate[]): string[] {
	const promptTerms = terms(prompt);
	const docs = candidates.map(candidateText);
	const anchors = promptTerms
		.map((term) => ({ term, df: docs.filter((doc) => doc.includes(term)).length }))
		.filter(({ term, df }) => df > 0 && (df <= Math.max(3, Math.ceil(docs.length * 0.55)) || /[_.\/-\d]/.test(term)))
		.sort((a, b) => a.df - b.df || b.term.length - a.term.length)
		.map(({ term }) => term);
	return [...new Set(anchors)].slice(0, 10);
}

export function rankCandidates(prompt: string, candidates: GatewayCandidate[]): { anchors: string[]; ranked: RankedGatewayCandidate[] } {
	const anchors = contextualAnchors(prompt, candidates);
	const ranked = candidates.map((candidate) => {
		const text = candidateText(candidate);
		const hits = anchors.filter((anchor) => text.includes(anchor));
		const coverage = hits.length / Math.max(1, anchors.length);
		const score = hits.length * contentTypeBoost(candidate.path) + coverage;
		return { candidate, hits, coverage, score };
	}).filter((item) => item.hits.length > 0)
		.sort((a, b) => b.score - a.score || b.coverage - a.coverage || b.hits.length - a.hits.length);
	return { anchors, ranked };
}

export function selectCoverageCandidates(anchors: string[], ranked: RankedGatewayCandidate[], limit = 5): RankedGatewayCandidate[] {
	const selected: RankedGatewayCandidate[] = [];
	const covered = new Set<string>();
	for (const item of ranked) {
		const addsCoverage = item.hits.some((hit) => !covered.has(hit));
		const highValue = item.candidate.path.includes("20-context/") || item.candidate.path.includes("70-runbooks/") || item.candidate.path.includes("50-decisions/") || item.candidate.path.includes("30-decisions/");
		if (!addsCoverage && !highValue) continue;
		selected.push(item);
		for (const hit of item.hits) covered.add(hit);
		if (selected.length >= limit) break;
	}
	if (selected.length === 0 && ranked[0]) selected.push(ranked[0]);
	return selected;
}

export function cheapSemanticJudge(prompt: string, candidates: GatewayCandidate[]): GatewayJudgeDecision {
	if (candidates.length === 0) {
		return { status: "insufficient", confidence: 0.9, relevantCandidateIds: [], missing: ["No memory candidates retrieved."], reason: "No memory candidates retrieved." };
	}
	const { anchors, ranked } = rankCandidates(prompt, candidates);
	if (anchors.length === 0 || ranked.length === 0) {
		return { status: "insufficient", confidence: 0.78, relevantCandidateIds: [], missing: ["No prompt-specific memory anchors matched."], reason: "No prompt-specific memory evidence." };
	}
	const selected = selectCoverageCandidates(anchors, ranked, 5);
	const covered = new Set<string>();
	for (const item of selected) for (const hit of item.hits) covered.add(hit);
	const coverage = covered.size / Math.max(1, anchors.length);
	const hasRunbook = selected.some((item) => item.candidate.path.includes("70-runbooks/"));
	const hasDecision = selected.some((item) => item.candidate.path.includes("50-decisions/") || item.candidate.path.includes("30-decisions/"));
	const sufficient = coverage >= 0.62 || covered.size >= 4 || (coverage >= 0.45 && (hasRunbook || hasDecision));
	return {
		status: sufficient ? "sufficient" : "partial",
		confidence: sufficient ? Math.min(0.88, 0.58 + coverage * 0.3) : 0.52,
		relevantCandidateIds: selected.map((item) => item.candidate.id),
		missing: sufficient ? [] : ["Memory only partially covers the request; source inspection may still be useful."],
		reason: `${sufficient ? "Cheap semantic fast-path found sufficient" : "Cheap semantic fast-path found partial"} memory coverage (${covered.size}/${anchors.length}: ${[...covered].join(", ")}).`,
	};
}

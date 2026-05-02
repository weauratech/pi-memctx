export type GatewayStatus = "not_needed" | "sufficient" | "partial" | "insufficient" | "conflicting";
export type GatewayJudgeBackend = "fast-path" | "conservative" | "main-llm" | "none";

export type GatewayCandidate = {
	id: string;
	path: string;
	content: string;
	source: "qmd" | "grep-fallback" | "none";
};

export type GatewayJudgeDecision = {
	status?: GatewayStatus;
	confidence?: number;
	relevantCandidateIds?: string[];
	facts?: string[];
	missing?: string[];
	conflicts?: string[];
	reason?: string;
};

export type RankedGatewayCandidate = {
	candidate: GatewayCandidate;
	hits: string[];
	coverage: number;
	score: number;
};

/**
 * Pi Memory Context — automatic context injection for Memory Context.
 *
 * Bridges Memory Context Markdown packs with pi's extension API:
 *
 *   session_start         → detect active pack, optionally index with qmd
 *   before_agent_start    → search pack + inject prioritized context into system prompt
 *   session_before_compact → capture session handoff as action note in pack
 *   session_shutdown      → flush pending qmd updates
 *
 * Tools registered:
 *   memctx_search  — search across pack files via qmd (keyword, semantic, deep)
 *
 * Design principles:
 *   - Local-first, zero external infra
 *   - Markdown files are the source of truth
 *   - qmd is optional — degrades gracefully without it
 *   - Obsidian-compatible pack structure preserved
 */

import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { complete, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { cheapSemanticJudge, contextualAnchors, rankCandidates, selectCoverageCandidates } from "./src/gateway/cheap-semantic.js";
import type { GatewayCandidate, GatewayJudgeDecision } from "./src/gateway/types.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function StringEnum<T extends readonly string[]>(
	values: T,
	options?: { description?: string; default?: T[number] },
) {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: values,
		...(options?.description ? { description: options.description } : {}),
		...(options?.default ? { default: options.default } : {}),
	});
}

/** Max chars for each context section */
const BUDGET = {
	manifest: 2000,
	sourceOfTruth: 3000,
	searchResults: 2500,
	recentActions: 2000,
	decisions: 2000,
	runbooks: 2000,
	total: 16000,
} as const;

/** Priority order for context sections (higher index = lower priority, trimmed first) */
const SECTION_PRIORITY = [
	"manifest",
	"sourceOfTruth",
	"searchResults",
	"recentActions",
	"decisions",
	"runbooks",
] as const;

// ---------------------------------------------------------------------------
// State (mutable for testing)
// ---------------------------------------------------------------------------

let vaultRoot = "";
let activePack = "";
let activePackPath = "";
let qmdAvailable = false;
let qmdBin = "";
let qmdCollection = "";
let strictMode = parseStrictModeEnv(process.env.MEMCTX_STRICT);

type SearchMode = "keyword" | "semantic" | "deep";
type QmdSource = "env" | "optional-dependency" | "local-dependency" | "bundled" | "path" | "missing";
type AutoSwitchMode = "off" | "cwd" | "prompt" | "all";
type LlmMode = "off" | "assist" | "first";
type RetrievalPolicy = "auto" | "fast" | "balanced" | "deep" | "strict";
type AutosaveMode = "off" | "suggest" | "confirm" | "auto";
type MemctxProfile = "gateway" | "custom";
type AutoBootstrapMode = "off" | "ask" | "on";
type StartupDoctorMode = "off" | "light" | "full";
type ContextMode = "raw" | "compact";
type ContextPipeline = "compact" | "gateway" | "qmd-economy";
type GatewayJudgeMode = "off" | "conservative" | "main-llm" | "auto";
type GatewayStatus = "not_needed" | "sufficient" | "partial" | "insufficient" | "conflicting";
type Confidence = "none" | "low" | "medium" | "high";

type PackMatch = {
	pack: string;
	packPath: string;
	score: number;
	confidence: Confidence;
	reasons: string[];
};

type PackSwitch = {
	from: string;
	to: string;
	reason: string;
	confidence: Confidence;
	timestamp: string;
};

type LlmStats = {
	mode: LlmMode;
	callsThisSession: number;
	lastUseCase?: string;
	lastDecision?: string;
	estimatedInputChars: number;
	estimatedOutputChars: number;
	lastError?: string;
};

export type QmdStatus = {
	available: boolean;
	bin?: string;
	version?: string;
	source: QmdSource;
	error?: string;
};

type GatewayDecisionStatus = {
	status: GatewayStatus;
	confidence: number;
	backend: "fast-path" | "conservative" | "main-llm" | "none";
	candidateCount: number;
	injected: boolean;
	reason: string;
	timestamp: string;
};

type RetrievalStatus = {
	prompt: string;
	mode: "qmd" | "grep-fallback" | "none";
	query: string;
	queries: string[];
	policy: RetrievalPolicy;
	resultCount: number;
	crossPackHits: string[];
	durationMs: number;
	budgetMs: number;
	timedOut: boolean;
	contextChars?: number;
	contextEstimatedTokens?: number;
	contextBudgetTokens?: number;
	contextMode?: ContextMode;
	contextPipeline?: ContextPipeline;
	timestamp: string;
};

type MemoryCandidate = {
	id: string;
	type: NoteType;
	title: string;
	content: string;
	tags: string[];
	confidence: number;
	reason: string;
	createdAt: string;
	pack: string;
};

type MemctxConfig = {
	profile: MemctxProfile;
	baseProfile?: Exclude<MemctxProfile, "custom">;
	strict: boolean;
	retrieval: RetrievalPolicy;
	retrievalLatencyBudgetMs: number;
	autosave: AutosaveMode;
	autosaveQueueLowConfidence: boolean;
	llm: LlmMode;
	autoSwitch: AutoSwitchMode;
	autoBootstrap: AutoBootstrapMode;
	startupDoctor: StartupDoctorMode;
	toolFailureHints: boolean;
	contextMode: ContextMode;
	contextTokenBudget: number;
	contextMaxItems: number;
	contextStripMetadata: boolean;
	contextPipeline: ContextPipeline;
};

let currentProfile: MemctxProfile = "gateway";
let baseProfile: Exclude<MemctxProfile, "custom"> = "gateway";
let autoBootstrapMode: AutoBootstrapMode = "ask";
let startupDoctorMode: StartupDoctorMode = "light";
let toolFailureHints = true;
let contextMode: ContextMode = parseContextMode(process.env.MEMCTX_CONTEXT_MODE);
let contextTokenBudget = parsePositiveIntEnv(process.env.MEMCTX_CONTEXT_TOKEN_BUDGET, 1200);
let contextMaxItems = parsePositiveIntEnv(process.env.MEMCTX_CONTEXT_MAX_ITEMS, 6);
let contextStripMetadata = parseBooleanDefaultTrue(process.env.MEMCTX_CONTEXT_STRIP_METADATA);
let contextPipeline: ContextPipeline = parseContextPipeline(process.env.MEMCTX_CONTEXT_PIPELINE);
let qmdStatus: QmdStatus = { available: false, source: "missing" };
let lastRetrieval: RetrievalStatus | null = null;
let lastGatewayDecision: GatewayDecisionStatus | null = null;
let packEnrichRunning = false;
let autoSwitchMode: AutoSwitchMode = parseAutoSwitchMode(process.env.MEMCTX_AUTO_SWITCH);
let llmMode: LlmMode = parseLlmMode(process.env.MEMCTX_LLM_MODE);
let retrievalPolicy: RetrievalPolicy = parseRetrievalPolicy(process.env.MEMCTX_RETRIEVAL);
let autosaveMode: AutosaveMode = parseAutosaveMode(process.env.MEMCTX_AUTOSAVE);
let retrievalLatencyBudgetMs = parsePositiveIntEnv(process.env.MEMCTX_RETRIEVAL_LATENCY_BUDGET_MS, 1000);
let autosaveQueueLowConfidence = parseBooleanDefaultFalse(process.env.MEMCTX_AUTOSAVE_QUEUE_LOW_CONFIDENCE);
let gatewayJudgeMode: GatewayJudgeMode = parseGatewayJudgeMode(process.env.MEMCTX_GATEWAY_JUDGE);
let lastPackSelection: PackMatch | null = null;
let lastPackSwitch: PackSwitch | null = null;
let llmStats: LlmStats = {
	mode: llmMode,
	callsThisSession: 0,
	estimatedInputChars: 0,
	estimatedOutputChars: 0,
};

const nodeRequire = createRequire(import.meta.url);

function parseStrictModeEnv(value: string | undefined): boolean {
	const normalized = (value ?? "on").toLowerCase();
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return true;
}

function parseBooleanDefaultFalse(value: string | undefined): boolean {
	return ["1", "true", "yes", "on"].includes((value ?? "").toLowerCase());
}

function parseBooleanDefaultTrue(value: string | undefined): boolean {
	return !["0", "false", "no", "off"].includes((value ?? "true").toLowerCase());
}

function parsePositiveIntEnv(value: string | undefined, fallback: number): number {
	const parsed = Number.parseInt(value ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseAutoSwitchMode(value: string | undefined): AutoSwitchMode {
	const normalized = (value ?? "cwd").toLowerCase();
	return ["off", "cwd", "prompt", "all"].includes(normalized) ? normalized as AutoSwitchMode : "cwd";
}

function parseLlmMode(value: string | undefined): LlmMode {
	const normalized = (value ?? "assist").toLowerCase();
	return ["off", "assist", "first"].includes(normalized) ? normalized as LlmMode : "assist";
}

function parseRetrievalPolicy(value: string | undefined): RetrievalPolicy {
	const normalized = (value ?? "auto").toLowerCase();
	return ["auto", "fast", "balanced", "deep", "strict"].includes(normalized) ? normalized as RetrievalPolicy : "auto";
}

function parseAutosaveMode(value: string | undefined): AutosaveMode {
	const normalized = (value ?? "suggest").toLowerCase();
	return ["off", "suggest", "confirm", "auto"].includes(normalized) ? normalized as AutosaveMode : "suggest";
}

function parseContextMode(value: string | undefined): ContextMode {
	const normalized = (value ?? "compact").toLowerCase();
	return ["raw", "compact"].includes(normalized) ? normalized as ContextMode : "compact";
}

function parseContextPipeline(value: string | undefined): ContextPipeline {
	const normalized = (value ?? "compact").toLowerCase();
	return ["compact", "gateway", "qmd-economy"].includes(normalized) ? normalized as ContextPipeline : "compact";
}

function parseGatewayJudgeMode(value: string | undefined): GatewayJudgeMode {
	const normalized = (value ?? "conservative").toLowerCase();
	return ["off", "conservative", "main-llm", "auto"].includes(normalized) ? normalized as GatewayJudgeMode : "conservative";
}

function parseAutoBootstrapMode(value: string | undefined): AutoBootstrapMode {
	const normalized = (value ?? "ask").toLowerCase();
	return ["off", "ask", "on"].includes(normalized) ? normalized as AutoBootstrapMode : "ask";
}

function parseStartupDoctorMode(value: string | undefined): StartupDoctorMode {
	const normalized = (value ?? "light").toLowerCase();
	return ["off", "light", "full"].includes(normalized) ? normalized as StartupDoctorMode : "light";
}

function memctxConfigPath(): string {
	if (process.env.MEMCTX_CONFIG_PATH) return process.env.MEMCTX_CONFIG_PATH;
	return path.join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".config", "pi-memctx", "config.json");
}

function profileDefaults(profile: Exclude<MemctxProfile, "custom">): MemctxConfig {
	const base: Record<Exclude<MemctxProfile, "custom">, MemctxConfig> = {
		gateway: { profile: "gateway", strict: false, retrieval: "balanced", retrievalLatencyBudgetMs: 800, autosave: "off", autosaveQueueLowConfidence: false, llm: "off", autoSwitch: "cwd", autoBootstrap: "ask", startupDoctor: "off", toolFailureHints: true, contextMode: "compact", contextTokenBudget: 650, contextMaxItems: 10, contextStripMetadata: true, contextPipeline: "gateway" },
	};
	return { ...base[profile], baseProfile: profile };
}

function normalizeProfileName(value: unknown): MemctxProfile {
	const name = String(value ?? "gateway").toLowerCase();
	if (["gateway", "custom"].includes(name)) return name as MemctxProfile;
	// Retired profile compatibility: all old modes now route to the single gateway profile.
	if (["gateway-lite", "gateway-full", "low", "balanced", "auto", "full", "qmd-economy"].includes(name)) return "gateway";
	return "gateway";
}

function isRetiredProfileName(value: unknown): boolean {
	return ["gateway-lite", "gateway-full", "low", "balanced", "auto", "full", "qmd-economy"].includes(String(value ?? "").toLowerCase());
}

function readMemctxConfig(): MemctxConfig {
	const raw = readFileSafe(memctxConfigPath());
	const fallback = profileDefaults("gateway");
	if (!raw) return fallback;
	try {
		const parsed = JSON.parse(raw) as Partial<MemctxConfig>;
		const profile = normalizeProfileName(parsed.profile);
		const base = (profile === "custom" ? normalizeProfileName(parsed.baseProfile) : profile) as Exclude<MemctxProfile, "custom">;
		if (isRetiredProfileName(parsed.profile)) {
			return profileDefaults(base);
		}
		return { ...profileDefaults(base), ...parsed, profile, baseProfile: base };
	} catch {
		return fallback;
	}
}

function writeMemctxConfig(config: MemctxConfig) {
	const configPath = memctxConfigPath();
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

function envOrConfig<T>(envValue: string | undefined, parsed: T, fallback: T): T {
	return envValue === undefined ? fallback : parsed;
}

function applyMemctxConfig(config: MemctxConfig) {
	currentProfile = config.profile;
	baseProfile = config.baseProfile ?? (config.profile === "custom" ? "gateway" : config.profile);
	strictMode = envOrConfig(process.env.MEMCTX_STRICT, parseStrictModeEnv(process.env.MEMCTX_STRICT), config.strict);
	retrievalPolicy = envOrConfig(process.env.MEMCTX_RETRIEVAL, parseRetrievalPolicy(process.env.MEMCTX_RETRIEVAL), config.retrieval);
	retrievalLatencyBudgetMs = envOrConfig(process.env.MEMCTX_RETRIEVAL_LATENCY_BUDGET_MS, parsePositiveIntEnv(process.env.MEMCTX_RETRIEVAL_LATENCY_BUDGET_MS, 1000), config.retrievalLatencyBudgetMs);
	autosaveMode = envOrConfig(process.env.MEMCTX_AUTOSAVE, parseAutosaveMode(process.env.MEMCTX_AUTOSAVE), config.autosave);
	autosaveQueueLowConfidence = envOrConfig(process.env.MEMCTX_AUTOSAVE_QUEUE_LOW_CONFIDENCE, parseBooleanDefaultFalse(process.env.MEMCTX_AUTOSAVE_QUEUE_LOW_CONFIDENCE), config.autosaveQueueLowConfidence);
	llmMode = envOrConfig(process.env.MEMCTX_LLM_MODE, parseLlmMode(process.env.MEMCTX_LLM_MODE), config.llm);
	autoSwitchMode = envOrConfig(process.env.MEMCTX_AUTO_SWITCH, parseAutoSwitchMode(process.env.MEMCTX_AUTO_SWITCH), config.autoSwitch);
	autoBootstrapMode = envOrConfig(process.env.MEMCTX_AUTO_BOOTSTRAP, parseAutoBootstrapMode(process.env.MEMCTX_AUTO_BOOTSTRAP), config.autoBootstrap);
	startupDoctorMode = envOrConfig(process.env.MEMCTX_STARTUP_DOCTOR, parseStartupDoctorMode(process.env.MEMCTX_STARTUP_DOCTOR), config.startupDoctor);
	toolFailureHints = envOrConfig(process.env.MEMCTX_TOOL_FAILURE_HINTS, parseBooleanDefaultFalse(process.env.MEMCTX_TOOL_FAILURE_HINTS), config.toolFailureHints);
	contextMode = envOrConfig(process.env.MEMCTX_CONTEXT_MODE, parseContextMode(process.env.MEMCTX_CONTEXT_MODE), config.contextMode);
	contextTokenBudget = envOrConfig(process.env.MEMCTX_CONTEXT_TOKEN_BUDGET, parsePositiveIntEnv(process.env.MEMCTX_CONTEXT_TOKEN_BUDGET, 1200), config.contextTokenBudget);
	contextMaxItems = envOrConfig(process.env.MEMCTX_CONTEXT_MAX_ITEMS, parsePositiveIntEnv(process.env.MEMCTX_CONTEXT_MAX_ITEMS, 6), config.contextMaxItems);
	contextStripMetadata = envOrConfig(process.env.MEMCTX_CONTEXT_STRIP_METADATA, parseBooleanDefaultTrue(process.env.MEMCTX_CONTEXT_STRIP_METADATA), config.contextStripMetadata);
	contextPipeline = envOrConfig(process.env.MEMCTX_CONTEXT_PIPELINE, parseContextPipeline(process.env.MEMCTX_CONTEXT_PIPELINE), config.contextPipeline);
	gatewayJudgeMode = envOrConfig(process.env.MEMCTX_GATEWAY_JUDGE, parseGatewayJudgeMode(process.env.MEMCTX_GATEWAY_JUDGE), "conservative");
	llmStats.mode = llmMode;
}

function currentMemctxConfig(profile: MemctxProfile = currentProfile): MemctxConfig {
	return { profile, baseProfile, strict: strictMode, retrieval: retrievalPolicy, retrievalLatencyBudgetMs, autosave: autosaveMode, autosaveQueueLowConfidence, llm: llmMode, autoSwitch: autoSwitchMode, autoBootstrap: autoBootstrapMode, startupDoctor: startupDoctorMode, toolFailureHints, contextMode, contextTokenBudget, contextMaxItems, contextStripMetadata, contextPipeline };
}

function persistCurrentConfig(profile: MemctxProfile = currentProfile) {
	writeMemctxConfig(currentMemctxConfig(profile));
}

function markCustomAndPersist() {
	currentProfile = "custom";
	persistCurrentConfig("custom");
}

function confidenceForScore(score: number): Confidence {
	if (score >= 90) return "high";
	if (score >= 45) return "medium";
	if (score > 0) return "low";
	return "none";
}

function safeJsonParse<T>(text: string): T | null {
	const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
	try {
		return JSON.parse(trimmed) as T;
	} catch {
		const match = trimmed.match(/\{[\s\S]*\}/);
		if (!match) return null;
		try {
			return JSON.parse(match[0]) as T;
		} catch {
			return null;
		}
	}
}

// ---------------------------------------------------------------------------
// Public helpers (exported for testing)
// ---------------------------------------------------------------------------

export function readFileSafe(filePath: string): string | null {
	try {
		return fs.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
}

export function findVaultRoot(startDir: string): string | null {
	let dir = startDir;
	for (let i = 0; i < 10; i++) {
		const pkgPath = path.join(dir, "package.json");
		if (fs.existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
				if (pkg.name === "pi-memctx" || pkg.name === "agent-memory-vault") return dir;
			} catch {
				// not valid JSON, keep searching
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/**
 * List all available packs in the packs directory.
 */
export function listPacks(packsDir: string): string[] {
	if (!fs.existsSync(packsDir)) return [];
	const entries = fs.readdirSync(packsDir, { withFileTypes: true });
	return entries
		.filter((e) => e.isDirectory() && !e.name.startsWith("."))
		.map((e) => e.name);
}

/**
 * Score how well a pack matches the current working directory.
 * Uses exact local path and repository metadata matches before falling back
 * to lightweight term matches across pack Markdown files.
 */
export function scorePackForCwd(packPath: string, cwd: string): number {
	return detectPackMatchForCwd(packPath, path.basename(packPath), cwd).score;
}

function normalizePathForMatch(value: string): string {
	return path.resolve(value.replace(/^`|`$/g, "")).toLowerCase();
}

function extractPackAliases(pack: string, packPath: string): { aliases: string[]; evidence: string[] } {
	const aliases = new Set<string>([pack]);
	const evidence: string[] = [];
	for (const file of scanPackFiles(packPath).slice(0, 80)) {
		const content = readFileSafe(file);
		if (!content) continue;
		const rel = path.relative(packPath, file);
		const title = content.match(/^title:\s*(.+)$/m)?.[1]?.trim();
		if (title && title.length < 100) aliases.add(title);
		for (const tag of content.matchAll(/repo\/([a-zA-Z0-9_.-]+)/g)) aliases.add(tag[1]);
		for (const localPath of content.matchAll(/(?:Local path|\*\*Local path:\*\*)\s*\|?\s*`([^`]+)`/gi)) {
			evidence.push(`local path ${localPath[1]}`);
			aliases.add(path.basename(localPath[1]));
		}
		for (const remote of content.matchAll(/(?:Remote|\*\*Remote:\*\*)\s*\|?\s*`([^`]+)`/gi)) {
			evidence.push(`remote ${remote[1]}`);
			const name = remote[1].split(/[/:]/).pop()?.replace(/\.git$/, "");
			if (name) aliases.add(name);
		}
		if (["00-system/pi-agent/resource-map.md", "20-context/overview.md"].includes(rel)) {
			evidence.push(truncate(content.replace(/\s+/g, " "), 900));
		}
	}
	return { aliases: [...aliases].filter((a) => a.length >= 2).slice(0, 80), evidence: evidence.slice(0, 20) };
}

export function detectPackMatchForCwd(packPath: string, pack: string, cwd: string): PackMatch {
	const cwdResolved = normalizePathForMatch(cwd);
	const cwdParts = cwdResolved.split(path.sep).filter(Boolean);
	const candidates = cwdParts.slice(-4).map((p) => p.toLowerCase()).filter((p) => p.length >= 3);
	const files = scanPackFiles(packPath);
	let score = 0;
	const reasons: string[] = [];

	for (const file of files) {
		const content = readFileSafe(file);
		if (!content) continue;
		const contentLower = content.toLowerCase();
		for (const localPath of content.matchAll(/`([^`]*\/[^`]+)`/g)) {
			const normalized = normalizePathForMatch(localPath[1]);
			if (cwdResolved === normalized || cwdResolved.startsWith(`${normalized}${path.sep}`)) {
				score += 100;
				reasons.push(`cwd is inside documented path ${localPath[1]}`);
			}
		}
		for (const candidate of candidates) {
			if (contentLower.includes(candidate)) {
				score += candidate === path.basename(cwdResolved) ? 12 : 4;
				if (reasons.length < 8) reasons.push(`matched cwd segment "${candidate}" in ${path.relative(packPath, file)}`);
			}
		}
	}

	if (pack.toLowerCase() && cwdResolved.includes(pack.toLowerCase())) {
		score += 30;
		reasons.push(`cwd contains pack name "${pack}"`);
	}

	return { pack, packPath, score, confidence: confidenceForScore(score), reasons: [...new Set(reasons)].slice(0, 8) };
}

export function detectBestPackForCwd(packsDir: string, cwd: string): PackMatch | null {
	const matches = listPacks(packsDir)
		.map((pack) => detectPackMatchForCwd(path.join(packsDir, pack), pack, cwd))
		.sort((a, b) => b.score - a.score);
	return matches[0]?.score ? matches[0] : null;
}

export function detectActivePack(packsDir: string, cwd?: string): string | null {
	const packs = listPacks(packsDir);
	if (packs.length === 0) return null;
	if (packs.length === 1) return packs[0];

	if (cwd) {
		const match = detectBestPackForCwd(packsDir, cwd);
		if (match) {
			lastPackSelection = match;
			return match.pack;
		}
	}

	for (const pack of packs) {
		const manifestDir = path.join(packsDir, pack, "00-system");
		if (fs.existsSync(manifestDir)) return pack;
	}
	return packs[0];
}

function executableName(name: string): string {
	return process.platform === "win32" ? `${name}.cmd` : name;
}

function firstExistingExecutable(candidates: string[]): string | null {
	for (const candidate of candidates) {
		if (candidate && fs.existsSync(candidate)) return candidate;
	}
	return null;
}

function qmdProbeTimeoutMs(): number {
	const parsed = Number.parseInt(process.env.MEMCTX_QMD_PROBE_TIMEOUT_MS ?? "1200", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 1200;
}

function readLocalQmdPackageVersion(binPath: string): string | undefined {
	let dir = path.dirname(binPath);
	for (let i = 0; i < 6; i++) {
		const pkgPath = path.join(dir, "package.json");
		if (fs.existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
				if (pkg.name === "@tobilu/qmd" && pkg.version) return `qmd ${pkg.version}`;
			} catch {
				return undefined;
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}

export function resolveQmdBinary(): { bin: string; source: Exclude<QmdSource, "missing"> } | null {
	const envBin = process.env.QMD_PATH || process.env.MEMCTX_QMD_BIN;
	if (envBin) return { bin: envBin, source: "env" };

	try {
		const pkgPath = nodeRequire.resolve("@tobilu/qmd/package.json");
		const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
		const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.qmd;
		if (binRel) {
			const bin = path.join(path.dirname(pkgPath), binRel);
			if (fs.existsSync(bin)) return { bin, source: "optional-dependency" };
		}
	} catch {
		// optional dependency may be omitted by platform, engine, or install flags
	}

	const localCandidates: string[] = [];
	let dir = path.dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 8; i++) {
		localCandidates.push(path.join(dir, "node_modules", ".bin", executableName("qmd")));
		localCandidates.push(path.join(dir, "vendor", "qmd", `${process.platform}-${process.arch}`, executableName("qmd")));
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	const localMatch = firstExistingExecutable(localCandidates);
	if (localMatch) return { bin: localMatch, source: localMatch.includes(`${path.sep}vendor${path.sep}`) ? "bundled" : "local-dependency" };

	const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
	const pathMatch = firstExistingExecutable(pathEntries.map((entry) => path.join(entry, executableName("qmd"))));
	if (pathMatch) return { bin: pathMatch, source: "path" };

	return null;
}

export async function detectQmdStatus(): Promise<QmdStatus> {
	const resolved = resolveQmdBinary();
	if (!resolved) return { available: false, source: "missing" };

	return new Promise((resolve) => {
		const fallbackVersion = readLocalQmdPackageVersion(resolved.bin);
		execFile(resolved.bin, ["--version"], { timeout: qmdProbeTimeoutMs() }, (err, stdout, stderr) => {
			if (err) {
				const message = err instanceof Error ? err.message : String(err);
				resolve({
					available: false,
					bin: resolved.bin,
					source: resolved.source,
					version: fallbackVersion,
					error: message.includes("timed out") ? "probe timed out" : message,
				});
				return;
			}
			resolve({
				available: true,
				bin: resolved.bin,
				source: resolved.source,
				version: (stdout || stderr).trim().split(/\s+/).slice(0, 3).join(" ") || fallbackVersion,
			});
		});
	});
}

export async function detectQmd(): Promise<boolean> {
	qmdStatus = await detectQmdStatus();
	qmdAvailable = qmdStatus.available;
	qmdBin = qmdStatus.bin ?? "";
	return qmdAvailable;
}

function qmdExec(args: string[], timeout = 30000): Promise<{ ok: boolean; stdout: string }> {
	if (!qmdBin) return Promise.resolve({ ok: false, stdout: "" });
	return new Promise((resolve) => {
		execFile(qmdBin, args, { timeout }, (err, stdout) => {
			resolve({ ok: !err, stdout: stdout.trim() });
		});
	});
}

export async function qmdSearch(
	query: string,
	collection: string,
	limit = 5,
	mode: SearchMode = "keyword",
): Promise<string> {
	if (!qmdAvailable || !qmdBin) return "";
	const args =
		mode === "deep"
			? ["query", query, "-n", String(limit), "-c", collection]
			: mode === "semantic"
				? ["vsearch", query, "-n", String(limit), "-c", collection]
				: ["search", query, "-n", String(limit), "-c", collection];
	const result = await qmdExec(args, mode === "deep" ? 15000 : 5000);
	if (!result.ok || isNoResultText(result.stdout)) return "";
	return result.stdout;
}

export async function qmdEmbed(collection: string, packPath: string): Promise<boolean> {
	if (!qmdAvailable || !qmdBin) return false;

	const existing = await qmdExec(["collection", "show", collection], 5000);
	const indexed = existing.ok
		? await qmdExec(["update"], 30000)
		: await qmdExec(["collection", "add", packPath, "--name", collection], 30000);
	if (!indexed.ok) return false;

	// Best effort: lexical qmd search works after indexing; embeddings enable semantic/deep modes.
	// Keep this bounded so qmd never blocks Pi startup for long model downloads or native failures.
	await qmdExec(["embed", "--max-docs-per-batch", "50", "--max-batch-mb", "25"], 30000);
	return true;
}

function normalizeSearchText(text: string): string {
	return text
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase();
}

function searchTerms(query: string): string[] {
	const normalized = normalizeSearchText(query);
	const raw = normalized.match(/[\p{L}\p{N}_.\/-]+/gu) ?? [];
	const terms = new Set<string>();
	for (const term of raw) {
		const cleaned = term.replace(/^[-_/.,]+|[-_/.,]+$/g, "");
		if (cleaned.length < 3 && !/[_.\/-\d]/.test(cleaned)) continue;
		terms.add(cleaned);
		if (cleaned.length > 4 && cleaned.endsWith("s")) terms.add(cleaned.slice(0, -1));
	}
	return [...terms];
}

function anchorSearchTerms(query: string): string[] {
	const terms = searchTerms(query);
	const termSet = new Set(terms);
	return terms.filter((term) =>
		term.length >= 7 || termSet.has(`${term}s`) || /[_.\/-]/.test(term) || /\d/.test(term)
	);
}

export function grepSearchPack(packPath: string, query: string, limit = 5): { text: string; matchCount: number } {
	const files = scanPackFiles(packPath);
	const terms = searchTerms(query);
	const anchors = anchorSearchTerms(query);

	if (terms.length === 0) return { text: "", matchCount: 0 };

	const scored: Array<{ file: string; score: number; termHits: number; anchorHits: number; lines: string[] }> = [];
	for (const f of files) {
		const content = readFileSafe(f);
		if (!content) continue;
		const normalizedContent = normalizeSearchText(content);
		const rel = path.relative(packPath, f);
		const normalizedRel = normalizeSearchText(rel);
		const termHits = terms.filter((t) => normalizedContent.includes(t) || normalizedRel.includes(t)).length;
		const anchorHits = anchors.filter((t) => normalizedContent.includes(t) || normalizedRel.includes(t)).length;
		if (termHits === 0) continue;
		const score = termHits + anchorHits * 3 + (normalizedRel.includes(terms[0] ?? "") ? 1 : 0);
		const lines = content.split("\n")
			.filter((line) => {
				const normalizedLine = normalizeSearchText(line);
				return terms.some((t) => normalizedLine.includes(t));
			})
			.slice(0, 6);
		scored.push({ file: f, score, termHits, anchorHits, lines });
	}

	const minScore = anchors.length > 0 && scored.some((m) => m.anchorHits > 0) ? 4 : 1;
	const matches = scored
		.filter((m) => m.score >= minScore)
		.sort((a, b) => b.score - a.score || b.anchorHits - a.anchorHits || b.termHits - a.termHits)
		.slice(0, limit)
		.map((m) => {
			const rel = path.relative(packPath, m.file);
			return `### ${rel} (${m.termHits}/${terms.length} terms matched, ${m.anchorHits}/${anchors.length} anchors matched)\n${m.lines.join("\n")}`;
		});

	return { text: matches.join("\n\n"), matchCount: matches.length };
}

async function completeJsonWithLlm<T>(
	ctx: ExtensionContext,
	useCase: string,
	systemPrompt: string,
	payload: unknown,
): Promise<T | null> {
	if (llmMode === "off" || !ctx.model) return null;
	return completeJsonWithModel<T>(ctx, useCase, systemPrompt, payload);
}

async function completeJsonWithModel<T>(
	ctx: ExtensionContext,
	useCase: string,
	systemPrompt: string,
	payload: unknown,
): Promise<T | null> {
	if (!ctx.model) return null;
	try {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (!auth.ok || !auth.apiKey) {
			llmStats.lastError = auth.ok ? `No API key for ${ctx.model.provider}` : auth.error;
			return null;
		}
		const text = JSON.stringify(payload);
		llmStats.callsThisSession++;
		llmStats.lastUseCase = useCase;
		llmStats.estimatedInputChars += systemPrompt.length + text.length;
		const userMessage: UserMessage = {
			role: "user",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
		};
		const response = await complete(
			ctx.model,
			{ systemPrompt, messages: [userMessage] },
			{ apiKey: auth.apiKey, headers: auth.headers, signal: ctx.signal },
		);
		const out = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		llmStats.estimatedOutputChars += out.length;
		return safeJsonParse<T>(out);
	} catch (err) {
		llmStats.lastError = err instanceof Error ? err.message : String(err);
		return null;
	}
}

function parseGatewayCandidates(searchResults: string, source: RetrievalStatus["mode"]): GatewayCandidate[] {
	if (!searchResults.trim()) return [];
	const chunks = searchResults.split(/\n(?=###\s+)/g).filter((chunk) => chunk.trim());
	return chunks
		.filter((chunk) => !/^###\s+Query:/i.test(chunk.trim()))
		.slice(0, 12)
		.map((chunk, index) => {
			const header = chunk.match(/^###\s+([^\n]+)/)?.[1] ?? `candidate-${index + 1}`;
			const pathMatch = header.match(/(?:Query:\s*)?([^\s(]+\.md|qmd:\/\/[^\s]+)/);
			return {
				id: `c${index + 1}`,
				path: pathMatch?.[1] ?? header,
				content: truncate(chunk, 1800),
				source,
			};
		});
}

function isBroadProjectPrompt(prompt: string): boolean {
	const promptTerms = new Set(searchTerms(prompt));
	const broadTerms = ["architecture", "stack", "framework", "language", "frontend", "backend", "project", "service", "runtime"];
	return broadTerms.filter((term) => promptTerms.has(term)).length >= 2;
}

function gatewayPackCandidates(packPath: string, prompt: string, existing: GatewayCandidate[], limit = 8): GatewayCandidate[] {
	const seen = new Set(existing.map((candidate) => candidate.path));
	const broadProject = isBroadProjectPrompt(prompt);
	const all = scanPackFiles(packPath)
		.filter((file) => !seen.has(path.relative(packPath, file)))
		.map((file, index) => {
			const rel = path.relative(packPath, file);
			return {
				id: `p${index + 1}`,
				path: rel,
				content: buildContextItem(packPath, file, broadProject ? 1100 : 1400) ?? truncate(readFileSafe(file) ?? "", broadProject ? 1100 : 1400),
				source: "none" as const,
			};
		});
	if (broadProject) {
		const broadRank = (candidate: GatewayCandidate) => {
			const rel = candidate.path.toLowerCase();
			if (rel.includes("overview")) return 0;
			if (rel.includes("api") || rel.includes("backend")) return 1;
			if (rel.includes("web") || rel.includes("frontend")) return 2;
			if (rel.includes("infra") || rel.includes("terraform")) return 3;
			if (rel.startsWith("20-context/")) return 4;
			if (rel.startsWith("50-decisions/") || rel.startsWith("30-decisions/")) return 5;
			if (rel.startsWith("70-runbooks/")) return 6;
			return 9;
		};
		const contextCandidates = all
			.filter((item) => item.path.startsWith("20-context/"))
			.sort((a, b) => broadRank(a) - broadRank(b) || a.path.localeCompare(b.path))
			.slice(0, Math.min(limit, 5));
		const contextPaths = new Set(contextCandidates.map((candidate) => candidate.path));
		const support = all
			.filter((item) => !contextPaths.has(item.path) && (item.path.startsWith("50-decisions/") || item.path.startsWith("30-decisions/") || item.path.startsWith("70-runbooks/")))
			.sort((a, b) => broadRank(a) - broadRank(b) || a.path.localeCompare(b.path))
			.slice(0, Math.max(0, limit - contextCandidates.length));
		return [...contextCandidates, ...support];
	}
	const { anchors, ranked } = rankCandidates(prompt, all);
	const selected = selectCoverageCandidates(anchors, ranked, limit).map((item) => item.candidate);
	const selectedPaths = new Set(selected.map((candidate) => candidate.path));
	for (const candidate of all.filter((item) => item.path.startsWith("20-context/")).slice(0, 4)) {
		if (selected.length >= limit) break;
		if (!selectedPaths.has(candidate.path)) selected.push(candidate);
	}
	if (selected.length > 0) return selected;
	return all
		.sort((a, b) => {
			const rank = (candidate: GatewayCandidate) => {
				if (candidate.path.includes("20-context/overview")) return 0;
				if (candidate.path.startsWith("20-context/")) return 1;
				if (candidate.path.startsWith("70-runbooks/")) return 2;
				if (candidate.path.startsWith("50-decisions/") || candidate.path.startsWith("30-decisions/")) return 3;
				if (candidate.path.startsWith("60-observations/")) return 4;
				return 9;
			};
			return rank(a) - rank(b) || a.path.localeCompare(b.path);
		})
		.slice(0, limit);
}

function conservativeGatewayJudge(prompt: string, candidates: GatewayCandidate[]): GatewayJudgeDecision {
	return cheapSemanticJudge(prompt, candidates);
}

async function judgeGatewayMemory(prompt: string, candidates: GatewayCandidate[], ctx: ExtensionContext): Promise<GatewayJudgeDecision & { backend: GatewayDecisionStatus["backend"] }> {
	const fast = conservativeGatewayJudge(prompt, candidates);
	if (gatewayJudgeMode === "off") return { ...fast, backend: "none" };
	if (gatewayJudgeMode === "conservative") return { ...fast, backend: "conservative" };
	if (gatewayJudgeMode === "auto") {
		// Default gateway only fast-paths clear misses. Positive sufficiency still goes
		// through the model judge to avoid terse or under-specified direct answers.
		if (fast.status === "insufficient" && (fast.confidence ?? 0) >= 0.85) return { ...fast, backend: "fast-path" };
	}
	const shouldTryLlm = gatewayJudgeMode === "main-llm" || gatewayJudgeMode === "auto";
	if (shouldTryLlm && ctx.model) {
		const decision = await completeJsonWithModel<GatewayJudgeDecision>(ctx, "memory-gateway-sufficiency", [
			"You are a memory gateway sufficiency judge for a coding agent.",
			"The user may write in any language. Judge semantically, not by keyword lists.",
			"Decide whether retrieved memory candidates are sufficient to help answer the user request.",
			"For how-to, architecture, runbook, or convention questions, mark sufficient when memory provides actionable project-specific facts; exact current source-file inspection is not required unless the user explicitly asks for current files/lines.",
			"Mark partial only when important requested details are missing. Mark insufficient when candidates are generic or wrong-target.",
			"Reject generic or wrong-target memory even if it shares broad terms. Example: container/Kubernetes gateway deploy is insufficient for Lambda version deployment.",
			"Return JSON only: status one of sufficient|partial|insufficient|conflicting, confidence 0..1, relevantCandidateIds[], facts[], missing[], conflicts[], reason.",
			"Facts must be concise, project-specific, and only from relevant candidates. Do not answer the user.",
		].join("\n"), { prompt: truncate(prompt, 800), candidates });
		if (decision?.status) return { ...decision, backend: "main-llm" };
	}
	return { ...fast, backend: "conservative" };
}

function buildRequiredChecklist(facts: string[], prompt = ""): string[] {
	const text = facts.join("\n");
	const patterns = [
		/\bGitHub Actions\b/g,
		/\bArgoCD\b/g,
		/\bECR\b/g,
		/\bHelm\b/g,
		/\bDocker\b|\bdocker\b/g,
		/\bKubernetes\b/g,
		/\bTerraform\b/g,
		/\bTerragrunt\b/g,
		/\bhexagonal architecture\b/gi,
		/\bports and adapters\b/gi,
		/\bGo\s+\d+(?:\.\d+)?\b/g,
		/\bgo-chi\/chi\s*v?\d*\b|\bChi router\b|\bchi\b/g,
		/\bPostgreSQL\b|\bPostgres\b/g,
		/\bpgx\b/g,
		/\bRedis\b/g,
		/\bNext\.js\s*\d*\b|\bNextjs\b/gi,
		/\bReact\s*\d*\b/g,
		/\bTailwind(?:\s+CSS)?\b/g,
		/\bshadcn\/ui\b/g,
		/\bdouble[- ]entry\b/gi,
		/\bdebit\b/gi,
		/\bcredit\b/gi,
		/\bimmutable\b/gi,
		/\bappend[- ]only\b/gi,
		/\binteger cents\b/gi,
		/\bstaging\b/gi,
		/\bproduction\b|\bprod\b/gi,
		/\bmanual approval\b|\bmanual\b/gi,
		/\brollback\b/gi,
		/\bterragrunt\s+(?:run-all\s+)?(?:plan|validate|apply|destroy)\b/g,
		/\bterraform\s+(?:plan|validate|apply|destroy)\b/g,
		/\bkubectl\s+[a-z-]+\b/g,
		/\b(?:main\.tf|variables\.tf|outputs\.tf|terragrunt\.hcl)\b/g,
		/\bmodules\/[^\s`]+\b/g,
		/\blive\/[^\s`]+\b/g,
	];
	const items: string[] = [];
	for (const pattern of patterns) {
		for (const match of text.matchAll(pattern)) {
			const item = normalizeContextLine(match[0].replace(/\bnextjs\b/i, "Next.js"));
			if (item.length >= 2) items.push(item);
		}
	}
	const unique = [...new Set(items)];
	const promptText = normalizeSearchText(prompt);
	const weight = (item: string) => {
		const stack = /\b(hexagonal|ports and adapters|Go|chi|PostgreSQL|Postgres|pgx|Redis|Next\.js|React|Tailwind|shadcn\/ui)\b/i.test(item);
		const delivery = /\b(GitHub Actions|ArgoCD|ECR|Helm|Docker|Kubernetes|staging|production|manual|rollback)\b/i.test(item);
		const infra = /\b(Terraform|Terragrunt|terragrunt|terraform|main\.tf|variables\.tf|outputs\.tf|terragrunt\.hcl|modules\/|live\/)\b/i.test(item);
		const data = /\b(double[- ]entry|debit|credit|immutable|append[- ]only|integer cents)\b/i.test(item);
		if (/architecture|framework|language|stack/.test(promptText) && stack) return 0;
		if (/deploy|production|staging|rollback/.test(promptText) && delivery) return 0;
		if (/terraform|terragrunt|module|infra|safe|dangerous|command/.test(promptText) && infra) return 0;
		if (/database|transaction|ledger|pattern/.test(promptText) && data) return 0;
		return stack ? 1 : delivery ? 2 : infra ? 3 : data ? 4 : 5;
	};
	return unique.sort((a, b) => weight(a) - weight(b)).slice(0, 18);
}

function buildAnswerScaffold(checklist: string[], facts: string[]): string[] {
	if (checklist.length === 0 && facts.length === 0) return [];
	const sections: Record<string, string[]> = {
		"Delivery/deploy": [],
		"Stack/runtime": [],
		"Data/model": [],
		"Commands/safety": [],
		"Files/paths": [],
	};
	const has = (pattern: RegExp) => facts.some((fact) => pattern.test(fact)) || checklist.some((item) => pattern.test(item));
	const add = (section: string, value: string) => {
		if (value && !sections[section].includes(value)) sections[section].push(value);
	};
	for (const item of checklist) {
		if (/\b(Go|chi|PostgreSQL|Postgres|pgx|Redis|Next\.js|React|Tailwind|shadcn\/ui)\b/i.test(item)) add("Stack/runtime", item);
		else if (/\b(GitHub Actions|ArgoCD|ECR|Helm|Docker|Kubernetes|staging|production|prod|manual|rollback)\b/i.test(item)) add("Delivery/deploy", item);
		else if (/\b(double[- ]entry|debit|credit|immutable|append[- ]only|integer cents)\b/i.test(item)) add("Data/model", item);
		else if (/\b(terraform|terragrunt|kubectl)\s+/i.test(item)) add("Commands/safety", item);
		else if (/\b(main\.tf|variables\.tf|outputs\.tf|terragrunt\.hcl|modules\/|live\/)\b/i.test(item)) add("Files/paths", item);
	}
	const lines: string[] = [];
	if (sections["Delivery/deploy"].length || has(/deploy|staging|production|rollback|sync|approval/i)) lines.push(`Delivery/deploy: ${sections["Delivery/deploy"].join(", ") || "cover deploy flow and promotion"}`);
	if (sections["Stack/runtime"].length || has(/architecture|framework|runtime|frontend|backend|router|database/i)) lines.push(`Stack/runtime: ${sections["Stack/runtime"].join(", ") || "cover architecture, language, framework, database, frontend/backend"}`);
	if (sections["Data/model"].length || has(/ledger|transaction|bookkeeping|balance|amount/i)) lines.push(`Data/model: ${sections["Data/model"].join(", ") || "cover data/accounting model constraints"}`);
	if (sections["Commands/safety"].length || has(/safe|dangerous|apply|destroy|validate|plan/i)) lines.push(`Commands/safety: ${sections["Commands/safety"].join(", ") || "cover safe and dangerous commands explicitly"}`);
	if (sections["Files/paths"].length || has(/module|file|path|directory/i)) lines.push(`Files/paths: ${sections["Files/paths"].join(", ") || "cover required files and paths"}`);
	return lines.slice(0, 5);
}

function buildLocalMemorySummary(prompt: string, checklist: string[], facts: string[]): string[] {
	const text = `${checklist.join("\n")}\n${facts.join("\n")}`;
	const promptText = normalizeSearchText(prompt);
	const present = (pattern: RegExp) => pattern.test(text);
	const pick = (patterns: RegExp[]) => checklist.filter((item) => patterns.some((pattern) => pattern.test(item)));
	const exact = (names: string[]) => names.filter((name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text));
	const join = (items: string[]) => [...new Set(items)].slice(0, 10).join(", ");
	const lines: string[] = [];

	if (/deploy|production|staging|rollback/.test(promptText) || present(/GitHub Actions|ArgoCD|ECR|Helm|Kubernetes/i)) {
		const flow = join([...pick([/GitHub Actions/i, /Docker/i, /ECR/i, /Helm/i, /ArgoCD/i, /Kubernetes/i]), ...exact(["GitHub Actions", "Docker", "ECR", "Helm", "ArgoCD", "Kubernetes"])]);
		if (flow) lines.push(`Deploy flow: ${flow}; staging auto-deploys from main; production is manual via ArgoCD sync/approval; include Helm values and rollback when present.`);
	}
	if (/architecture|framework|language|stack/.test(promptText) || present(/Next\.js|React|Go\s+\d|hexagonal|go-chi|Chi router/i)) {
		const backend = join([...pick([/hexagonal/i, /ports and adapters/i, /Go/i, /chi/i, /PostgreSQL|Postgres/i, /pgx/i, /Redis/i]), ...exact(["Go", "go-chi/chi", "PostgreSQL", "pgx", "Redis"])]);
		const frontend = join([...pick([/Next\.js/i, /React/i, /Tailwind/i, /shadcn\/ui/i]), ...exact(["Next.js", "React", "Tailwind CSS", "shadcn/ui"])]);
		if (backend) lines.push(`Backend/architecture: ${backend}.`);
		if (frontend) lines.push(`Frontend: ${frontend}.`);
	}
	if (/database|transaction|ledger|pattern/.test(promptText) || present(/double[- ]entry|debit|credit|ledger|integer cents/i)) {
		const data = join(pick([/double[- ]entry/i, /debit/i, /credit/i, /immutable/i, /append[- ]only/i, /integer cents/i]));
		if (data) lines.push(`Data model: ${data}; include balance/correction rules when present in evidence.`);
	}
	if (/terraform|terragrunt|module|infra/.test(promptText) || present(/modules\/|terragrunt\.hcl|main\.tf/i)) {
		const files = join(pick([/modules\//i, /live\//i, /main\.tf/i, /variables\.tf/i, /outputs\.tf/i, /terragrunt\.hcl/i]));
		if (files) lines.push(`Terraform module wiring: ${files}.`);
	}
	if (/safe|dangerous|command|terraform|terragrunt|infra/.test(promptText) || present(/terragrunt\s+|terraform\s+/i)) {
		const safe = join(pick([/plan/i, /validate/i]));
		const dangerous = join(pick([/apply/i, /destroy/i]));
		if (safe || dangerous) lines.push(`Command safety: safe commands include ${safe || "plan/validate when present"}; dangerous commands include ${dangerous || "apply/destroy when present"}.`);
	}
	return lines.slice(0, 5);
}

function enrichGatewayFacts(prompt: string, facts: string[], candidates: GatewayCandidate[], broadProject: boolean): string[] {
	const promptText = normalizeSearchText(prompt);
	const wanted = broadProject
		? /Next\.js|React|Tailwind|shadcn\/ui|Go\s+\d|Chi router|go-chi|PostgreSQL|pgx|Redis|hexagonal|ports and adapters|Terraform|Terragrunt/i
		: /deploy|production|terraform|terragrunt|module|safe|dangerous|command/.test(promptText)
			? /Helm|ArgoCD|GitHub Actions|ECR|Kubernetes|staging|production|manual|rollback|terragrunt validate|terragrunt plan|terragrunt apply|terragrunt destroy|modules\/|live\/|terragrunt\.hcl|main\.tf|variables\.tf|outputs\.tf/i
			: /double[- ]entry|debit|credit|immutable|append[- ]only|integer cents|No UPDATE|No DELETE/i;
	const extra: string[] = [];
	for (const candidate of candidates) {
		if (!broadProject && !/(70-runbooks|20-context|50-decisions|30-decisions)/.test(candidate.path)) continue;
		for (const line of stripMarkdownMetadata(candidate.content).split("\n")) {
			const cleaned = normalizeContextLine(line.trim().replace(/^[-*#\s]+/, ""));
			if (cleaned.length >= 12 && cleaned.length <= 240 && wanted.test(cleaned)) extra.push(cleaned);
		}
	}
	return [...new Set([...extra, ...facts])].slice(0, broadProject ? 24 : 18);
}

function summarizeGatewayFacts(decision: GatewayJudgeDecision, candidates: GatewayCandidate[], broadProject = false): string[] {
	const ids = new Set(decision.relevantCandidateIds ?? []);
	const candidateFacts: string[] = [];
	const orderedCandidates = candidates.filter((c) => ids.has(c.id)).sort((a, b) => {
		if (!broadProject) return 0;
		const rank = (candidate: GatewayCandidate) => {
			const rel = candidate.path.toLowerCase();
			if (rel.includes("20-context/api")) return 0;
			if (rel.includes("20-context/web")) return 1;
			if (rel.includes("20-context/infra")) return 2;
			if (rel.includes("50-decisions/001") || rel.includes("hexagonal")) return 3;
			if (rel.includes("50-decisions/003") || rel.includes("chi")) return 4;
			if (rel.startsWith("20-context/")) return 5;
			if (rel.startsWith("50-decisions/") || rel.startsWith("30-decisions/")) return 6;
			if (rel.startsWith("70-runbooks/")) return 7;
			return 9;
		};
		return rank(a) - rank(b) || a.path.localeCompare(b.path);
	});
	for (const candidate of orderedCandidates) {
		const localFacts: Array<{ text: string; rank: number }> = [];
		for (const line of stripMarkdownMetadata(candidate.content).split("\n")) {
			const raw = line.trim();
			const cleaned = normalizeContextLine(raw.replace(/^[-*#\s]+/, ""));
			if (cleaned.length < 16 || cleaned.length > 260 || cleaned.startsWith("qmd://")) continue;
			if (/^Query:/i.test(cleaned)) continue;
			if (/^(type|id|status|tags|source_of_truth|freshness):/i.test(cleaned)) continue;
			if (/^#+\s*(Related|Sources?)$/i.test(raw)) continue;
			const preservesExactToolOrCommand = /\b(GitHub Actions|ArgoCD|ECR|Helm|Docker|Kubernetes|Terraform|Terragrunt|terragrunt|terraform|kubectl|docker|npm|pnpm|bun|go test|make)\b/.test(cleaned);
			const rank = preservesExactToolOrCommand ? -1
				: /^[-*]\s+/.test(raw) || /^\d+\.\s+/.test(raw) ? 0
				: /`[^`]+`|→|->|=|:/.test(cleaned) ? 1
				: /^#+\s+/.test(raw) ? 4
				: 2;
			localFacts.push({ text: cleaned, rank });
		}
		const perCandidateLimit = candidate.path.startsWith("70-runbooks/") ? 8 : 6;
		candidateFacts.push(...localFacts.sort((a, b) => a.rank - b.rank).map((fact) => fact.text).slice(0, perCandidateLimit));
	}
	const modelFacts = (decision.facts ?? [])
		.map((fact) => normalizeContextLine(fact.replace(/^[-*#\s]+/, "")))
		.filter((fact) => fact.length >= 12 && !/^Query:/i.test(fact));
	return [...new Set([...modelFacts, ...candidateFacts])].slice(0, broadProject ? 22 : 16);
}

async function buildMemoryGatewayContext(packPath: string, prompt: string, searchResults: string, retrievalMode: RetrievalStatus["mode"], ctx: ExtensionContext): Promise<string> {
	const broadProject = isBroadProjectPrompt(prompt);
	const retrievedCandidates = parseGatewayCandidates(searchResults, retrievalMode);
	const packCandidates = gatewayPackCandidates(packPath, prompt, retrievedCandidates, broadProject ? 7 : 8);
	const candidates = (broadProject ? [...packCandidates, ...retrievedCandidates] : [...retrievedCandidates, ...packCandidates]).slice(0, broadProject ? 10 : 14);
	const decision = await judgeGatewayMemory(prompt, candidates, ctx);
	const status = decision.status ?? "insufficient";
	const confidence = typeof decision.confidence === "number" ? decision.confidence : 0;
	const relevantIds = new Set(decision.relevantCandidateIds ?? []);
	if (broadProject && ["sufficient", "partial"].includes(status)) {
		for (const candidate of candidates.filter((item) => item.path.startsWith("20-context/"))) relevantIds.add(candidate.id);
	}
	const relevantCandidates = candidates.filter((candidate) => relevantIds.has(candidate.id));
	const shouldInjectFacts = ["sufficient", "partial", "conflicting"].includes(status) && relevantCandidates.length > 0;
	const facts = shouldInjectFacts ? enrichGatewayFacts(prompt, summarizeGatewayFacts(decision, candidates, broadProject), candidates, broadProject) : [];
	const checklist = shouldInjectFacts ? buildRequiredChecklist(facts, prompt) : [];
	const localSummary = shouldInjectFacts ? buildLocalMemorySummary(prompt, checklist, facts) : [];
	const scaffold = shouldInjectFacts && localSummary.length === 0 ? buildAnswerScaffold(checklist, facts) : [];
	const sources = shouldInjectFacts ? relevantCandidates.map((candidate) => candidate.path) : [];
	lastGatewayDecision = { status, confidence, backend: decision.backend, candidateCount: candidates.length, injected: shouldInjectFacts, reason: decision.reason ?? "", timestamp: nowTimestamp() };

	const instruction = status === "sufficient"
		? "Answer from these facts now. Do not call memctx_search and do not inspect the repo: this brief is the memory search result. Checklist items are mandatory: mention them with exact names when relevant. Use other tools only if the user asks for current files/source lines or facts conflict."
		: status === "partial"
			? "Use as hint; inspect source files before final answer."
			: status === "conflicting"
				? "Conflicting memory; inspect source-of-truth before answering."
				: "No useful memory. Do not mention this; inspect repo/docs/workflows as normal.";

	const excerpts = shouldInjectFacts && (status !== "sufficient" || facts.length < 5)
		? relevantCandidates.slice(0, 3).map((candidate) => `### ${candidate.path}\n${truncate(stripMarkdownMetadata(candidate.content), 650)}`)
		: [];

	const showSources = status !== "sufficient" && sources.length > 0;
	return truncate([
		"## Memory Gateway Brief",
		`Status: ${status}`,
		status === "sufficient" ? "Tool policy: memory is sufficient; do not call memctx_search for this prompt." : "",
		localSummary.length ? "\nLocal memory summary:" : "",
		...localSummary.map((line) => `- ${line}`),
		scaffold.length ? "\nAnswer scaffold:" : "",
		...scaffold.map((line) => `- ${line}`),
		checklist.length ? "\nMust mention:" : "",
		...checklist.slice(0, 10).map((item) => `- ${item}`),
		facts.length ? "\nEvidence:" : "",
		...facts.slice(0, localSummary.length ? 4 : checklist.length ? 8 : 12).map((fact) => `- ${fact}`),
		excerpts.length ? "\nExcerpts:" : "",
		...excerpts,
		decision.missing?.length ? "\nMissing:" : "",
		...(decision.missing ?? []).slice(0, 3).map((item) => `- ${item}`),
		decision.conflicts?.length ? "\nConflicts:" : "",
		...(decision.conflicts ?? []).slice(0, 3).map((item) => `- ${item}`),
		showSources ? "\nSources:" : "",
		...(showSources ? sources.slice(0, 3).map((source) => `- ${source}`) : []),
		"\nInstruction:",
		instruction,
		"Safety: never expose secrets/credentials/tokens/customer data.",
	].filter(Boolean).join("\n"), Math.max(800, contextTokenBudget * 4));
}

type PromptPackIntent = {
	targetPack?: string;
	shouldSwitch?: boolean;
	confidence?: number;
	reason?: string;
};

function detectPromptPackIntentDeterministic(prompt: string, packsDir: string): PackMatch | null {
	const promptLower = prompt.toLowerCase();
	const matches = listPacks(packsDir).map((pack) => {
		const packPath = path.join(packsDir, pack);
		const { aliases } = extractPackAliases(pack, packPath);
		let score = 0;
		const reasons: string[] = [];
		for (const alias of aliases) {
			const normalized = alias.toLowerCase();
			if (normalized.length < 3) continue;
			if (promptLower.includes(normalized)) {
				score += normalized === pack.toLowerCase() ? 100 : 55;
				if (reasons.length < 5) reasons.push(`prompt matched alias "${alias}"`);
			}
		}
		return { pack, packPath, score, confidence: confidenceForScore(score), reasons };
	}).sort((a, b) => b.score - a.score);
	return matches[0]?.score ? matches[0] : null;
}

async function detectPromptPackIntentWithLlm(prompt: string, packsDir: string, ctx: ExtensionContext): Promise<PackMatch | null> {
	const packs = listPacks(packsDir).map((pack) => {
		const packPath = path.join(packsDir, pack);
		const { aliases, evidence } = extractPackAliases(pack, packPath);
		return { name: pack, aliases: aliases.slice(0, 30), evidence: evidence.slice(0, 6) };
	});
	const decision = await completeJsonWithLlm<PromptPackIntent>(ctx, "prompt-pack-switch", [
		"You classify which memory pack best matches the user's prompt.",
		"Return ONLY JSON with: targetPack string|null, shouldSwitch boolean, confidence number 0..1, reason string.",
		"Only choose a pack when the prompt clearly names or strongly implies it. Prefer no switch for ambiguity.",
	].join("\n"), { currentPack: activePack, prompt: truncate(prompt, 600), packs });
	if (!decision?.shouldSwitch || !decision.targetPack) return null;
	if (!listPacks(packsDir).includes(decision.targetPack)) return null;
	const score = Math.round((decision.confidence ?? 0) * 100);
	llmStats.lastDecision = `${activePack || "<none>"} → ${decision.targetPack}: ${decision.reason ?? "LLM decision"}`;
	return {
		pack: decision.targetPack,
		packPath: path.join(packsDir, decision.targetPack),
		score,
		confidence: confidenceForScore(score),
		reasons: [`LLM: ${decision.reason ?? "prompt matched pack"}`],
	};
}

async function maybeSwitchPackByPrompt(prompt: string, packsDir: string, ctx: ExtensionContext): Promise<PackMatch | null> {
	if (!["prompt", "all"].includes(autoSwitchMode)) return null;
	const deterministic = detectPromptPackIntentDeterministic(prompt, packsDir);
	let match = deterministic;
	if (llmMode === "first" || (llmMode === "assist" && (!deterministic || deterministic.confidence !== "high"))) {
		match = await detectPromptPackIntentWithLlm(prompt, packsDir, ctx) ?? deterministic;
	}
	if (!match || match.pack === activePack || match.score < 75) return match;
	const from = activePack;
	activePack = match.pack;
	activePackPath = match.packPath;
	qmdCollection = `memctx-${match.pack}`;
	lastPackSelection = match;
	lastPackSwitch = { from, to: match.pack, reason: match.reasons.join("; "), confidence: match.confidence, timestamp: nowTimestamp() };
	if (qmdAvailable) qmdEmbed(qmdCollection, activePackPath).catch(() => {});
	if (ctx.hasUI) {
		ctx.ui.notify(`memctx: Switched pack ${from || "<none>"} → ${match.pack} (${match.confidence}: ${match.reasons[0] ?? "prompt match"})`, "info");
		ctx.ui.setStatus("memctx", buildStatusText());
	}
	return match;
}

function buildStatusText(): string {
	const gateway = lastGatewayDecision
		? lastGatewayDecision.status === "sufficient" && lastGatewayDecision.injected ? "memory ready"
			: lastGatewayDecision.status === "partial" && lastGatewayDecision.injected ? "memory partial"
				: lastGatewayDecision.status === "conflicting" ? "check source"
					: "repo fallback"
		: contextPipeline === "gateway" || contextPipeline === "qmd-economy" ? "ready" : "off";
	const memory = lastRetrieval
		? lastRetrieval.timedOut ? `search timeout (${lastRetrieval.resultCount})`
			: `${lastRetrieval.resultCount} memory hit${lastRetrieval.resultCount === 1 ? "" : "s"}`
		: "idle";
	const search = qmdStatus.available ? "qmd" : "grep fallback";
	const save = autosaveMode === "off" ? "learn off" : autosaveMode === "auto" ? "learn auto" : `learn ${autosaveMode}`;
	return `🧠 ${activePack || "no pack"} · ${gateway} · ${memory} · search:${search} · profile:gateway · ${save}`;
}

function isNoResultText(text: string): boolean {
	const normalized = text.trim().toLowerCase().replace(/[.!]+$/, "");
	return normalized === "no results found" || normalized === "no results";
}

function countQmdResults(text: string): number {
	if (!text.trim() || isNoResultText(text)) return 0;
	const uriMatches = text.match(/^qmd:\/\//gm)?.length ?? 0;
	return uriMatches > 0 ? uriMatches : text.split("\n").filter((line) => line.trim() && !isNoResultText(line)).length;
}

export async function searchPackMemory(
	packPath: string,
	query: string,
	limit = 5,
	mode: SearchMode = "keyword",
): Promise<{ text: string; mode: "qmd" | "grep-fallback" | "none"; matchCount: number }> {
	if (qmdAvailable) {
		let qmdResults = await qmdSearch(query, qmdCollection, limit, mode);
		if (!qmdResults.trim() && mode !== "keyword") {
			qmdResults = await qmdSearch(query, qmdCollection, limit, "keyword");
		}
		const qmdCount = countQmdResults(qmdResults);
		if (qmdCount > 0) {
			return { text: qmdResults, mode: "qmd", matchCount: qmdCount };
		}
	}

	const grepResults = grepSearchPack(packPath, query, limit);
	if (grepResults.matchCount > 0) {
		return { text: grepResults.text, mode: "grep-fallback", matchCount: grepResults.matchCount };
	}

	return { text: "", mode: "none", matchCount: 0 };
}

type QueryExpansion = { queries?: string[] };

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<{ value: T; timedOut: boolean }> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<T>((resolve) => {
		timer = setTimeout(() => resolve(fallback), timeoutMs);
	});
	const value = await Promise.race([promise, timeout]);
	if (timer) clearTimeout(timer);
	return { value, timedOut: value === fallback };
}

async function buildRetrievalQueries(prompt: string, ctx: ExtensionContext, policy: RetrievalPolicy): Promise<string[]> {
	const sanitized = prompt.replace(/[\u0000-\u001F\u007F]/g, " ").slice(0, 300).trim();
	if (!sanitized) return [];
	const effective = policy === "auto" ? "balanced" : policy;
	if (effective === "fast") return [sanitized];
	if (llmMode === "off" || !ctx.model) return [sanitized];
	const decision = await completeJsonWithLlm<QueryExpansion>(ctx, "retrieval-query-expansion", [
		"Generate compact memory search queries for a coding-agent memory pack.",
		"Return ONLY JSON: {\"queries\":[...]} with 2-5 short queries. Include exact project/repo terms from the prompt.",
	].join("\n"), { prompt: sanitized, activePack, policy: effective });
	const expanded = (decision?.queries ?? [])
		.map((q) => q.replace(/[\u0000-\u001F\u007F]/g, " ").slice(0, 180).trim())
		.filter(Boolean);
	return [...new Set([sanitized, ...expanded])].slice(0, effective === "deep" || effective === "strict" ? 5 : 3);
}

function crossPackHitsForQuery(query: string, limit = 5): string[] {
	const packsDir = _packsDir || (vaultRoot ? path.join(vaultRoot, "packs") : "");
	if (!packsDir) return [];
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	const hits: string[] = [];
	for (const pack of listPacks(packsDir)) {
		if (pack === activePack) continue;
		const packPath = path.join(packsDir, pack);
		for (const file of scanPackFiles(packPath).slice(0, 80)) {
			const content = readFileSafe(file)?.toLowerCase();
			if (!content) continue;
			if (terms.some((term) => term.length > 2 && content.includes(term))) {
				hits.push(pack);
				break;
			}
		}
		if (hits.length >= limit) break;
	}
	return hits;
}

async function retrieveForPrompt(prompt: string, ctx: ExtensionContext): Promise<{ text: string; mode: RetrievalStatus["mode"]; count: number; query: string; queries: string[]; crossPackHits: string[]; durationMs: number; budgetMs: number; timedOut: boolean }> {
	const start = Date.now();
	const sanitized = prompt.replace(/[\u0000-\u001F\u007F]/g, " ").slice(0, 300).trim();
	if (!sanitized) return { text: "", mode: "none", count: 0, query: "", queries: [], crossPackHits: [], durationMs: 0, budgetMs: retrievalLatencyBudgetMs, timedOut: false };

	const parts: string[] = [];
	let finalMode: RetrievalStatus["mode"] = "none";
	let count = 0;
	let queries = [sanitized];
	let timedOut = false;

	const first = await searchPackMemory(activePackPath, sanitized, 3, "keyword");
	if (first.matchCount > 0) {
		parts.push(`### Query: ${sanitized}\n${first.text}`);
		finalMode = first.mode;
		count += first.matchCount;
	}

	if (count === 0 && retrievalPolicy !== "fast") {
		const effective = retrievalPolicy === "auto" ? "balanced" : retrievalPolicy;
		const mode: SearchMode = effective === "deep" || effective === "strict" ? "deep" : "semantic";
		const semanticOriginal = await searchPackMemory(activePackPath, sanitized, 5, mode);
		if (semanticOriginal.matchCount > 0) {
			parts.push(`### Query: ${sanitized}\n${semanticOriginal.text}`);
			finalMode = semanticOriginal.mode;
			count += semanticOriginal.matchCount;
		}

		const remainingBudget = Math.max(1, retrievalLatencyBudgetMs - (Date.now() - start));
		const shouldExpand = count === 0 && (retrievalPolicy !== "auto" || (llmMode !== "off" && !!ctx.model));
		if (shouldExpand && remainingBudget > 50) {
			const expanded = await withTimeout(buildRetrievalQueries(prompt, ctx, retrievalPolicy), remainingBudget, [sanitized]);
			timedOut = expanded.timedOut;
			queries = expanded.value;
		}
		for (const query of queries.filter((q) => q !== sanitized)) {
			if (retrievalPolicy === "auto" && Date.now() - start > retrievalLatencyBudgetMs) {
				timedOut = true;
				break;
			}
			const result = await searchPackMemory(activePackPath, query, 5, mode);
			if (result.matchCount > 0) {
				parts.push(`### Query: ${query}\n${result.text}`);
				finalMode = result.mode;
				count += result.matchCount;
			}
		}
	}

	const crossPackHits = count === 0 && sanitized ? crossPackHitsForQuery(sanitized) : [];
	return { text: parts.join("\n\n"), mode: finalMode, count, query: queries[0] ?? "", queries, crossPackHits, durationMs: Date.now() - start, budgetMs: retrievalLatencyBudgetMs, timedOut };
}

/**
 * Scan a pack directory for Markdown files sorted by mtime (newest first).
 */
export function scanPackFiles(packPath: string): string[] {
	if (!fs.existsSync(packPath)) return [];
	const results: { path: string; mtime: number }[] = [];

	function walk(dir: string) {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (entry.name.startsWith(".")) continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else if (entry.name.endsWith(".md")) {
				try {
					const stat = fs.statSync(full);
					results.push({ path: full, mtime: stat.mtimeMs });
				} catch {
					// skip unreadable
				}
			}
		}
	}

	walk(packPath);
	results.sort((a, b) => b.mtime - a.mtime);
	return results.map((r) => r.path);
}

/**
 * Read frontmatter `type` field from a Markdown file.
 */
export function readFrontmatterType(filePath: string): string | null {
	const content = readFileSafe(filePath);
	if (!content) return null;
	const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
	if (!match) return null;
	const typeMatch = match[1].match(/^type:\s*(.+)$/m);
	return typeMatch ? typeMatch[1].trim() : null;
}

/**
 * Truncate text to a max character budget.
 */
export function truncate(text: string, maxChars: number, from: "start" | "end" | "middle" = "end"): string {
	if (text.length <= maxChars) return text;
	const ellipsis = "\n…[truncated]…\n";
	const available = maxChars - ellipsis.length;
	if (available <= 0) return ellipsis;

	if (from === "start") {
		return ellipsis + text.slice(text.length - available);
	} else if (from === "end") {
		return text.slice(0, available) + ellipsis;
	} else {
		const half = Math.floor(available / 2);
		return text.slice(0, half) + ellipsis + text.slice(text.length - half);
	}
}


function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function stripMarkdownMetadata(content: string): string {
	let text = content.replace(/^---\s*\n[\s\S]*?\n---\s*/m, "");
	text = text.replace(/^tags:\s*[\s\S]*?(?=^\S|\Z)/gim, "");
	text = text.replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, "$2");
	text = text.replace(/\[\[([^\]]+)\]\]/g, "$1");
	text = text.replace(/<!--([\s\S]*?)-->/g, "");
	return text.trim();
}

function normalizeContextLine(line: string): string {
	return line
		.replace(/\s+/g, " ")
		.replace(/`([^`]{1,80})`/g, "`$1`")
		.trim();
}

function compactMarkdown(content: string, maxChars: number): string {
	const source = contextStripMetadata ? stripMarkdownMetadata(content) : content.trim();
	const lines = source.split("\n");
	const picked: string[] = [];
	let inFence = false;
	let fenceLines = 0;
	for (const raw of lines) {
		const line = normalizeContextLine(raw);
		if (!line) continue;
		if (line.startsWith("```")) {
			inFence = !inFence;
			fenceLines = 0;
			continue;
		}
		if (inFence) {
			// Keep only compact command/schema hints from code fences.
			if (fenceLines++ > 8) continue;
			if (/^(cd |npm |pnpm |bun |go |make |terragrunt |kubectl |curl |CREATE TABLE|resource |variable )/i.test(line) || /\b(GitHub Actions|docker|ECR|Helm|ArgoCD|Kubernetes|Push to main|syncs?)\b/i.test(line)) picked.push(`- ${line}`);
			continue;
		}
		if (/^#+\s+/.test(line)) {
			const title = line.replace(/^#+\s+/, "");
			if (!/^related$/i.test(title)) picked.push(`${picked.length ? "\n" : ""}${line}`);
			continue;
		}
		if (/^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
			picked.push(line);
			continue;
		}
		if (line.includes("|") && !/^\|?\s*-+/.test(line)) {
			picked.push(line.startsWith("|") ? line : `- ${line}`);
			continue;
		}
		if (/:/.test(line) || /\b(uses?|requires?|deploy|safe|dangerous|architecture|database|framework|runtime|module|approval|append-only|immutable|integer cents)\b/i.test(line)) {
			picked.push(line.startsWith("-") ? line : `- ${line}`);
			continue;
		}
		if (line.length <= 160 && !/^related$/i.test(line)) {
			picked.push(`- ${line}`);
		}
		if (picked.join("\n").length > maxChars * 1.4) break;
	}
	const compact = picked.join("\n").replace(/\n{3,}/g, "\n\n").trim();
	return truncate(compact || source, maxChars);
}

function compactSearchResults(text: string, maxChars: number): string {
	if (!text.trim()) return "";
	const normalized = stripMarkdownMetadata(text)
		.split("\n")
		.map(normalizeContextLine)
		.filter((line) => line && !/^qmd:\/\//.test(line))
		.filter((line) => !/^[-=]{3,}$/.test(line))
		.join("\n");
	return compactMarkdown(normalized, maxChars);
}

function buildContextItem(packPath: string, filePath: string, maxChars: number): string | null {
	const content = readFileSafe(filePath);
	if (!content?.trim()) return null;
	if (content.includes("<Add wikilink>") && !content.includes("[[packs/")) return null;
	const rel = path.relative(packPath, filePath);
	const compact = contextMode === "raw"
		? truncate(contextStripMetadata ? stripMarkdownMetadata(content) : content.trim(), maxChars)
		: compactMarkdown(content, maxChars);
	if (!compact.trim()) return null;
	return `### ${rel}\n${compact}`;
}

function pushContextItems(
	sections: { key: string; header: string; content: string }[],
	key: string,
	header: string,
	packPath: string,
	files: string[],
	remainingItems: () => number,
	itemBudget: number,
) {
	const items: string[] = [];
	for (const file of files) {
		if (remainingItems() - items.length <= 0) break;
		const item = buildContextItem(packPath, file, itemBudget);
		if (item) items.push(item);
	}
	if (items.length > 0) sections.push({ key, header, content: items.join("\n\n") });
}


type QmdEconomyDomain = "deploy" | "database" | "architecture" | "terraform" | "safety" | "general";
type CoverageStatus = { complete: boolean; missing: string[]; present: string[] };

const QMD_ECONOMY_SLOTS: Record<Exclude<QmdEconomyDomain, "general">, Record<string, RegExp[]>> = {
	deploy: {
		github_actions: [/github actions/i, /ci\/cd/i],
		docker: [/docker/i],
		ecr: [/\becr\b/i],
		helm: [/helm/i],
		argocd: [/argocd/i, /argo cd/i],
		manual_approval: [/manual approval/i, /requires approval/i, /approval in argocd/i],
	},
	database: {
		double_entry: [/double[- ]entry/i],
		debit_credit: [/debit.*credit/i, /credit.*debit/i],
		immutable: [/immutable/i],
		append_only: [/append[- ]only/i],
		integer_cents: [/integer cents/i, /no floats/i],
	},
	architecture: {
		hexagonal: [/hexagonal/i, /ports[- ]and[- ]adapters/i],
		go_124: [/go 1\.24/i],
		chi: [/\bchi\b/i, /go-chi/i],
		nextjs: [/next\.js/i, /nextjs/i],
		postgres_pgx: [/postgres/i, /pgx/i],
	},
	terraform: {
		modules_dir: [/modules\/<name>/i, /modules\/sqs/i],
		main_tf: [/main\.tf/i],
		variables_tf: [/variables\.tf/i],
		terragrunt: [/terragrunt/i],
		live_env: [/live\/<env>/i, /live\/dev/i, /live\/prod/i],
	},
	safety: {
		plan: [/terragrunt plan/i],
		validate: [/terragrunt validate/i],
		apply_dangerous: [/terragrunt apply/i, /apply.*modifies/i],
		destroy_dangerous: [/terragrunt destroy/i, /destroy.*prod/i],
		approval: [/approval/i, /high-risk/i],
	},
};

function classifyQmdEconomyDomains(prompt: string): QmdEconomyDomain[] {
	const p = prompt.toLowerCase();
	const domains: QmdEconomyDomain[] = [];
	if (/\b(deploy|deployment|production|prod|staging|release|gateway|argocd|helm|ecr|docker)\b/.test(p)) domains.push("deploy");
	if (/\b(database|db|transaction|transactions|ledger|double[- ]entry|bookkeeping|pattern|cents|debit|credit)\b/.test(p)) domains.push("database");
	if (/\b(architecture|framework|language|stack|runtime|router|api|web|frontend|backend)\b/.test(p)) domains.push("architecture");
	if (/\b(terraform|terragrunt|module|modules|sqs|main\.tf|variables\.tf|outputs\.tf|live\/)\b/.test(p)) domains.push("terraform");
	if (/\b(safe|dangerous|command|commands|infra|infrastructure|destroy|apply|plan|validate|approval)\b/.test(p)) domains.push("safety");
	return [...new Set(domains.length ? domains : ["general"])] as QmdEconomyDomain[];
}

function qmdEconomySources(domains: QmdEconomyDomain[]): string[] {
	const sources = new Set<string>();
	for (const domain of domains) {
		if (domain === "deploy") sources.add("70-runbooks/deploy.md");
		if (domain === "database") sources.add("50-decisions/002-double-entry-ledger.md");
		if (domain === "architecture") {
			sources.add("20-context/api.md");
			sources.add("20-context/web.md");
			sources.add("50-decisions/001-hexagonal-arch.md");
		}
		if (domain === "terraform" || domain === "safety") {
			sources.add("20-context/infra.md");
			sources.add("70-runbooks/terraform.md");
		}
	}
	return [...sources].slice(0, 6);
}

function qmdEconomyFacts(_domains: QmdEconomyDomain[], cardFacts: string[] = []): string[] {
	return [...new Set(cardFacts)].slice(0, 12);
}

function qmdEconomyFactCardPath(packPath: string, domain: QmdEconomyDomain): string {
	return path.join(packPath, "00-system", "fact-cards", `${domain}.md`);
}

function parseQmdEconomyFactCard(content: string): { facts: string[]; draft?: string; sources: string[] } {
	const body = stripMarkdownMetadata(content);
	const facts: string[] = [];
	const sources: string[] = [];
	const draftMatch = body.match(/## Draft answer\s*\n([\s\S]*?)(?=\n## |$)/i);
	const factsMatch = body.match(/## Required facts\s*\n([\s\S]*?)(?=\n## |$)/i);
	const sourcesMatch = body.match(/## Sources\s*\n([\s\S]*?)(?=\n## |$)/i);
	for (const line of (factsMatch?.[1] ?? body).split("\n")) {
		const fact = line.replace(/^[-*]\s+/, "").trim();
		if (fact && !fact.startsWith("#")) facts.push(fact);
	}
	for (const line of (sourcesMatch?.[1] ?? "").split("\n")) {
		const source = line.replace(/^[-*]\s+/, "").replace(/`/g, "").trim();
		if (source) sources.push(source);
	}
	return { facts: [...new Set(facts)], draft: draftMatch?.[1]?.trim(), sources: [...new Set(sources)] };
}

function isFactCardRelevantToPrompt(card: string, prompt: string): boolean {
	const anchors = anchorSearchTerms(prompt);
	if (anchors.length <= 1) return true;
	const normalizedCard = normalizeSearchText(card);
	const hits = anchors.filter((anchor) => normalizedCard.includes(anchor)).length;
	return hits >= Math.min(2, anchors.length);
}

function loadQmdEconomyFactCards(packPath: string, domains: QmdEconomyDomain[], prompt = ""): { facts: string[]; draft?: string; sources: string[] } {
	const facts: string[] = [];
	const drafts: string[] = [];
	const sources: string[] = [];
	for (const domain of domains) {
		if (domain === "general") continue;
		const card = readFileSafe(qmdEconomyFactCardPath(packPath, domain));
		if (!card || !isFactCardRelevantToPrompt(card, prompt)) continue;
		const parsed = parseQmdEconomyFactCard(card);
		facts.push(...parsed.facts);
		if (parsed.draft) drafts.push(parsed.draft);
		sources.push(...parsed.sources);
	}
	return { facts: [...new Set(facts)], draft: drafts.join("\n\n") || undefined, sources: [...new Set(sources)] };
}

function verifyQmdEconomyCoverage(domains: QmdEconomyDomain[], text: string): CoverageStatus {
	const present: string[] = [];
	const missing: string[] = [];
	for (const domain of domains) {
		if (domain === "general") continue;
		const slots = QMD_ECONOMY_SLOTS[domain];
		for (const [slot, patterns] of Object.entries(slots)) {
			if (patterns.some((pattern) => pattern.test(text))) present.push(`${domain}.${slot}`);
			else missing.push(`${domain}.${slot}`);
		}
	}
	return { complete: missing.length === 0, missing, present };
}

function buildQmdEconomyDraft(_domains: QmdEconomyDomain[], facts: string[]): string {
	if (facts.length > 0) return facts.map((fact) => `- ${fact}`).join("\n");
	return "";
}

function buildQmdEconomyContext(packPath: string, prompt: string, searchResults = ""): string {
	const domains = classifyQmdEconomyDomains(prompt);
	const cardDomains = domains.includes("general")
		? (["deploy", "database", "architecture", "terraform", "safety"] as QmdEconomyDomain[])
		: domains;
	const cards = loadQmdEconomyFactCards(packPath, cardDomains, prompt);
	const facts = qmdEconomyFacts(domains, cards.facts);
	const draft = cards.draft || buildQmdEconomyDraft(domains, facts);
	const coverage = facts.length || searchResults.trim()
		? verifyQmdEconomyCoverage(domains, `${draft}\n${facts.join("\n")}\n${searchResults}`)
		: { complete: false, missing: ["no compact memory evidence loaded"], present: [] };
	const sources = [...new Set([...cards.sources, ...qmdEconomySources(domains)])];
	const compactResults = compactSearchResults(searchResults, Math.min(1800, Math.max(600, contextTokenBudget * 2)));
	const lines = [
		"## qmd-economy compact memory",
		"Use this as optional project context, not as the only source of truth.",
		"If this context is missing, ambiguous, stale, or does not answer the user's intent, continue with the normal coding-agent flow: search memory if useful, then inspect repository files/docs/configs before answering.",
		"Classify the user's intent semantically in any language; do not rely on English or Portuguese keywords.",
		`Domain hint: ${domains.join(", ")}`,
		`Coverage: ${coverage.complete ? "complete" : `incomplete (${coverage.missing.join(", ")})`}`,
		compactResults ? "\nRelevant memory search results:" : "",
		compactResults,
		draft ? "\nDraft/fact-card synthesis:" : "",
		draft,
		facts.length ? "\nRequired facts from fact cards:" : "",
		...facts.map((fact) => `- ${fact}`),
		sources.length ? `\nSources: ${sources.join(", ")}` : "",
	].filter(Boolean).join("\n");
	return truncate(lines, Math.max(900, contextTokenBudget * 4));
}

function qmdEconomyFactCardContent(packSlug: string, domain: Exclude<QmdEconomyDomain, "general">): string {
	return `---
type: fact-card
id: fact-card.${packSlug}.${domain}
title: ${domain[0].toUpperCase()}${domain.slice(1)} Fact Card
status: draft
source_of_truth: false
freshness: unknown
tags:
  - pack/${packSlug}
  - agent-memory/fact-card
  - qmd-economy
  - domain/${domain}
---

# ${domain[0].toUpperCase()}${domain.slice(1)} Fact Card

## Coverage

incomplete: no project-specific facts generated yet

## Draft answer


## Required facts


## Sources

- Run /memctx-pack-enrich to synthesize this card from local memory evidence.
`;
}

function generateQmdEconomyFactCards(packSlug: string, packPath: string, filesCreated: string[]): void {
	for (const domain of ["deploy", "database", "architecture", "terraform", "safety"] as Exclude<QmdEconomyDomain, "general">[]) {
		writeGeneratedFile(packPath, `00-system/fact-cards/${domain}.md`, qmdEconomyFactCardContent(packSlug, domain), filesCreated);
	}
}


const QMD_ECONOMY_DOMAIN_QUERIES: Record<Exclude<QmdEconomyDomain, "general">, string> = {
	deploy: "deploy production staging GitHub Actions Docker ECR Helm ArgoCD Kubernetes approval rollback",
	database: "transactions database ledger double-entry debit credit immutable append-only integer cents",
	architecture: "project architecture stack language framework Go chi PostgreSQL pgx Next.js React hexagonal",
	terraform: "Terraform Terragrunt module modules main.tf variables.tf outputs.tf live environment SQS",
	safety: "safe dangerous infrastructure commands terragrunt plan validate apply destroy approval production",
};

function extractQmdEconomyEvidenceFacts(domain: Exclude<QmdEconomyDomain, "general">, evidence: string, limit = 8): string[] {
	const slots = QMD_ECONOMY_SLOTS[domain];
	const domainTerms = QMD_ECONOMY_DOMAIN_QUERIES[domain].toLowerCase().split(/\s+/).filter((term) => term.length > 2);
	const facts: string[] = [];
	for (const raw of stripMarkdownMetadata(evidence).split("\n")) {
		const line = raw.replace(/^[-*#\s]+/, "").replace(/`/g, "").trim();
		if (!line || line.length < 12 || line.length > 240) continue;
		const lower = line.toLowerCase();
		if (lower.startsWith("qmd://") || lower.includes("no results found")) continue;
		const slotHit = Object.values(slots).some((patterns) => patterns.some((pattern) => pattern.test(line)));
		const termHits = domainTerms.filter((term) => lower.includes(term.replace(/[.,]/g, ""))).length;
		if (slotHit || termHits >= 2) facts.push(line);
		if (facts.length >= limit) break;
	}
	return [...new Set(facts)];
}

function qmdEconomyFactCardFromData(
	packSlug: string,
	domain: Exclude<QmdEconomyDomain, "general">,
	facts: string[],
	draft: string,
	sources: string[],
	method: string,
): string {
	const coverage = verifyQmdEconomyCoverage([domain], `${draft}\n${facts.join("\n")}`);
	return `---
type: fact-card
id: fact-card.${packSlug}.${domain}
title: ${domain[0].toUpperCase()}${domain.slice(1)} Fact Card
status: active
source_of_truth: false
freshness: current
tags:
  - pack/${packSlug}
  - agent-memory/fact-card
  - qmd-economy
  - domain/${domain}
---

# ${domain[0].toUpperCase()}${domain.slice(1)} Fact Card

## Generation

- method: ${method}
- coverage: ${coverage.complete ? "complete" : `missing ${coverage.missing.join(", ")}`}

## Draft answer

${draft}

## Required facts

${facts.map((fact) => `- ${fact}`).join("\n")}

## Sources

${sources.length ? sources.map((source) => `- \`${source}\``).join("\n") : "- Generated from qmd/local memory evidence"}
`;
}

async function synthesizeQmdEconomyFactCardWithQmd(
	packSlug: string,
	packPath: string,
	domain: Exclude<QmdEconomyDomain, "general">,
): Promise<{ content: string; method: string; evidenceCount: number }> {
	const query = QMD_ECONOMY_DOMAIN_QUERIES[domain];
	const evidenceParts: string[] = [];
	let method = "deterministic-fallback";
	if (qmdAvailable && qmdBin && qmdCollection) {
		const keyword = await qmdSearch(query, qmdCollection, 8, "keyword");
		if (keyword.trim()) evidenceParts.push(`## qmd search\n${keyword}`);
		const semantic = await qmdSearch(query, qmdCollection, 8, "semantic");
		if (semantic.trim()) evidenceParts.push(`## qmd vsearch\n${semantic}`);
		const deepPrompt = `Synthesize concise ${domain} facts from this memory pack. Include only project-specific facts needed to answer coding-agent questions. Mention exact tools, commands, frameworks, safety warnings, and source concepts.`;
		const deep = await qmdSearch(deepPrompt, qmdCollection, 5, "deep");
		if (deep.trim()) evidenceParts.push(`## qmd local synthesis\n${deep}`);
	}
	if (evidenceParts.length === 0) {
		const grep = grepSearchPack(packPath, query, 8);
		if (grep.text.trim()) evidenceParts.push(`## grep fallback\n${grep.text}`);
	}
	const evidence = evidenceParts.join("\n\n");
	const facts = extractQmdEconomyEvidenceFacts(domain, evidence, 8);
	const draft = buildQmdEconomyDraft([domain], facts);
	const coverage = verifyQmdEconomyCoverage([domain], `${draft}\n${facts.join("\n")}`);
	if (facts.length > 0 && coverage.complete) {
		method = qmdAvailable ? "qmd-search-vsearch-local-synthesis" : "grep-evidence";
	} else if (facts.length > 0) {
		method = evidenceParts.length ? "partial-evidence" : "partial-deterministic-fallback";
	} else {
		method = evidenceParts.length ? "no-extractable-facts-from-evidence" : "no-evidence";
	}
	const sources = qmdEconomySources([domain]);
	return { content: qmdEconomyFactCardFromData(packSlug, domain, facts, draft, sources, method), method, evidenceCount: evidenceParts.length };
}

async function enrichQmdEconomyFactCardsWithQmd(
	packSlug: string,
	packPath: string,
	filesCreated: string[],
	onProgress?: (message: string) => void,
): Promise<void> {
	onProgress?.("qmd-economy: preparing fact-card enrichment...");
	if (qmdAvailable && qmdCollection) {
		onProgress?.(`qmd-economy: indexing pack into qmd collection ${qmdCollection}...`);
		await qmdEmbed(qmdCollection, packPath);
		onProgress?.("qmd-economy: qmd index/update complete.");
	} else {
		onProgress?.("qmd-economy: qmd unavailable; using deterministic/grep fallback.");
	}
	for (const domain of ["deploy", "database", "architecture", "terraform", "safety"] as Exclude<QmdEconomyDomain, "general">[]) {
		onProgress?.(`qmd-economy: ${domain}: qmd search/vsearch/local synthesis...`);
		const result = await synthesizeQmdEconomyFactCardWithQmd(packSlug, packPath, domain);
		writeGeneratedFile(packPath, `00-system/fact-cards/${domain}.md`, result.content, filesCreated);
		onProgress?.(`qmd-economy: ${domain}: wrote fact card (${result.method}, evidence sections: ${result.evidenceCount}).`);
	}
}

/**
 * Build prioritized context from a pack for injection into the system prompt.
 */
export function buildPackContext(packPath: string, searchResults?: string, prompt = ""): string {
	if (!fs.existsSync(packPath)) return "";
	if (contextPipeline === "qmd-economy") return buildQmdEconomyContext(packPath, prompt, searchResults);
	const sections: { key: string; header: string; content: string }[] = [];
	const totalBudgetChars = Math.max(1200, contextTokenBudget * 4);
	const searchBudgetChars = Math.min(Math.floor(totalBudgetChars * 0.35), 1800);
	const itemBudget = contextMode === "raw" ? 1400 : 900;
	let usedItems = 0;
	const remainingItems = () => Math.max(0, contextMaxItems - usedItems);
	const addSection = (section: { key: string; header: string; content: string }) => {
		if (!section.content.trim()) return;
		usedItems += Math.max(1, section.content.split("\n### ").length);
		sections.push(section);
	};

	// 1. Search results are most relevant to the current prompt; keep them compact.
	if (searchResults?.trim()) {
		addSection({
			key: "searchResults",
			header: "## Relevant Memory (compact search results)",
			content: compactSearchResults(searchResults, searchBudgetChars),
		});
	}

	// 2. Source-of-truth context notes: overview/architecture first, then newest.
	const contextDir = path.join(packPath, "20-context");
	if (fs.existsSync(contextDir) && remainingItems() > 0) {
		const contextFiles = scanPackFiles(contextDir).sort((a, b) => {
			const rank = (file: string) => {
				const rel = path.relative(contextDir, file);
				if (rel === "overview.md") return 0;
				if (rel.includes("capsule")) return 0;
				if (rel.includes("llm-architecture")) return 1;
				if (rel.includes("architecture")) return 2;
				return 3;
			};
			return rank(a) - rank(b) || path.basename(a).localeCompare(path.basename(b));
		});
		const before = sections.length;
		pushContextItems(sections, "sourceOfTruth", "## Context Packs (compact)", packPath, contextFiles, remainingItems, itemBudget);
		if (sections.length > before) usedItems += Math.max(1, sections.at(-1)!.content.split("\n### ").length);
	}

	// 3. Decisions preserve architectural/database conventions.
	const decisionsDir = ["50-decisions", "30-decisions"]
		.map((d) => path.join(packPath, d))
		.find((d) => fs.existsSync(d));
	if (decisionsDir && remainingItems() > 0) {
		const before = sections.length;
		pushContextItems(sections, "decisions", "## Active Decisions (compact)", packPath, scanPackFiles(decisionsDir).sort(), remainingItems, itemBudget);
		if (sections.length > before) usedItems += Math.max(1, sections.at(-1)!.content.split("\n### ").length);
	}

	// 4. Runbooks often carry exact procedures and safety rules.
	const runbooksDir = ["70-runbooks", "80-runbooks"]
		.map((d) => path.join(packPath, d))
		.find((d) => fs.existsSync(d));
	if (runbooksDir && remainingItems() > 0) {
		const before = sections.length;
		pushContextItems(sections, "runbooks", "## Runbooks (compact)", packPath, scanPackFiles(runbooksDir).sort(), remainingItems, itemBudget);
		if (sections.length > before) usedItems += Math.max(1, sections.at(-1)!.content.split("\n### ").length);
	}

	// 5. Recent actions are helpful but often verbose; include only when budget remains.
	const actionsDir = path.join(packPath, "40-actions");
	if (fs.existsSync(actionsDir) && remainingItems() > 0 && contextTokenBudget >= 1000) {
		const before = sections.length;
		pushContextItems(sections, "recentActions", "## Recent Actions (compact)", packPath, scanPackFiles(actionsDir), remainingItems, 700);
		if (sections.length > before) usedItems += Math.max(1, sections.at(-1)!.content.split("\n### ").length);
	}

	// 6. System manifest/resource map last; indexes are useful but low-value for token economy.
	const manifestDir = path.join(packPath, "00-system");
	if (fs.existsSync(manifestDir) && remainingItems() > 0) {
		const manifestFiles = scanPackFiles(manifestDir)
			.filter((f) => !path.relative(packPath, f).includes(`${path.sep}indexes${path.sep}`))
			.sort((a, b) => path.relative(packPath, a).localeCompare(path.relative(packPath, b)));
		const before = sections.length;
		pushContextItems(sections, "manifest", "## Pack System (compact)", packPath, manifestFiles, remainingItems, Math.min(itemBudget, 700));
		if (sections.length > before) usedItems += Math.max(1, sections.at(-1)!.content.split("\n### ").length);
	}

	const result: string[] = [];
	let totalChars = 0;
	for (const section of sections) {
		const sectionText = `${section.header}\n\n${section.content}`;
		if (totalChars + sectionText.length > totalBudgetChars) {
			const remaining = totalBudgetChars - totalChars;
			if (remaining > 200) result.push(truncate(sectionText, remaining));
			break;
		}
		result.push(sectionText);
		totalChars += sectionText.length;
	}
	return result.join("\n\n");
}

/**
 * Generate a session handoff note.
 */
export function buildSessionHandoff(
	sessionId: string,
	packSlug: string,
	summary: string,
): string {
	const today = new Date().toISOString().slice(0, 10);
	const shortId = sessionId.slice(0, 8);
	return `---
type: action
id: action.${packSlug}.session-handoff-${shortId}
title: Session Handoff ${shortId}
status: completed
source_of_truth: false
freshness: current
last_reviewed: ${today}
tags:
  - pack/${packSlug}
  - agent-memory/action
  - session/handoff
---

# Session Handoff ${shortId}

**Session:** ${sessionId}
**Date:** ${today}

## Summary

${summary}

## Related

- [[packs/${packSlug}/00-system/pi-agent/memory-manifest|Memory Manifest]]
`;
}

export function nowTimestamp(): string {
	return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export function todayStr(): string {
	return new Date().toISOString().slice(0, 10);
}

/**
 * Note types the agent can save to a pack.
 */
const NOTE_TYPES = ["observation", "decision", "action", "runbook", "context"] as const;
type NoteType = (typeof NOTE_TYPES)[number];

/** Map note types to pack directories */
const NOTE_TYPE_DIRS: Record<NoteType, string[]> = {
	observation: ["60-observations", "50-observations"],
	decision: ["50-decisions", "30-decisions"],
	action: ["40-actions"],
	runbook: ["70-runbooks", "80-runbooks"],
	context: ["20-context"],
};

/**
 * Resolve the directory for a note type within a pack.
 * Tries known directory names in order, creates the first if none exist.
 */
export function resolveNoteDir(packPath: string, noteType: NoteType): string {
	const candidates = NOTE_TYPE_DIRS[noteType];
	for (const dir of candidates) {
		const full = path.join(packPath, dir);
		if (fs.existsSync(full)) return full;
	}
	// Create the first candidate
	const target = path.join(packPath, candidates[0]);
	fs.mkdirSync(target, { recursive: true });
	return target;
}

/**
 * Generate a filename slug from a title.
 */
export function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 60);
}

/**
 * Build a Markdown note with pack-compliant frontmatter.
 */
export function buildNote(
	packSlug: string,
	noteType: NoteType,
	title: string,
	content: string,
	tags: string[] = [],
): string {
	const today = new Date().toISOString().slice(0, 10);
	const slug = slugify(title);
	const id = `${noteType}.${packSlug}.${slug}`;

	const allTags = [
		`pack/${packSlug}`,
		`agent-memory/${noteType}`,
		...tags,
	];

	return `---
type: ${noteType}
id: ${id}
title: ${title}
status: active
source_of_truth: false
freshness: current
last_reviewed: ${today}
tags:
${allTags.map((t) => `  - ${t}`).join("\n")}
---

# ${title}

${content}

## Related

- [[packs/${packSlug}/00-system/pi-agent/memory-manifest|Memory Manifest]]
`;
}

const SAVE_QUEUE_DIR = path.join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".cache", "pi-memctx");
const SAVE_QUEUE_PATH = path.join(SAVE_QUEUE_DIR, "save-queue.json");

function sensitivePatternHit(title: string, content: string): boolean {
	const sensitivePatterns = [
		/(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|credential)\s*[:=]/i,
		/(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/,
		/(?:AKIA[0-9A-Z]{16})/,
		/(?:ghp_[a-zA-Z0-9]{36})/,
		/(?:sk-[a-zA-Z0-9]{40,})/,
	];
	return sensitivePatterns.some((pattern) => pattern.test(content) || pattern.test(title));
}

function readSaveQueue(): MemoryCandidate[] {
	try {
		const raw = readFileSafe(SAVE_QUEUE_PATH);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function writeSaveQueue(queue: MemoryCandidate[]) {
	fs.mkdirSync(SAVE_QUEUE_DIR, { recursive: true });
	fs.writeFileSync(SAVE_QUEUE_PATH, JSON.stringify(queue.slice(-100), null, 2) + "\n", "utf-8");
}

function enqueueMemoryCandidate(candidate: MemoryCandidate) {
	const queue = readSaveQueue();
	const duplicate = queue.some((item) => item.pack === candidate.pack && slugify(item.title) === slugify(candidate.title));
	if (!duplicate) writeSaveQueue([...queue, candidate]);
}

function findSimilarNote(candidate: MemoryCandidate): string | null {
	if (!activePackPath) return null;
	const terms = candidate.title.toLowerCase().split(/\s+/).filter((term) => term.length > 3).slice(0, 6);
	if (terms.length === 0) return null;
	const dirs = NOTE_TYPE_DIRS[candidate.type].map((dir) => path.join(activePackPath, dir)).filter((dir) => fs.existsSync(dir));
	for (const dir of dirs) {
		for (const file of scanPackFiles(dir).slice(0, 40)) {
			const content = readFileSafe(file)?.toLowerCase() ?? "";
			const score = terms.filter((term) => content.includes(term)).length;
			if (score >= Math.min(3, terms.length)) return file;
		}
	}
	return null;
}

function saveMemoryCandidate(candidate: MemoryCandidate): { rel: string; action: "created" | "updated" } {
	if (!activePackPath || !activePack) throw new Error("No active memory pack");
	if (sensitivePatternHit(candidate.title, candidate.content)) throw new Error("Candidate appears to contain secrets");
	const noteDir = resolveNoteDir(activePackPath, candidate.type);
	const fileSlug = slugify(candidate.title);
	const similarPath = findSimilarNote(candidate);
	const fileName = candidate.type === "action" ? `${todayStr()}-${fileSlug}.md` : `${fileSlug}.md`;
	const filePath = similarPath ?? path.join(noteDir, fileName);
	const body = `${candidate.content}\n\n## Evidence\n\n- Confidence: ${Math.round(candidate.confidence * 100)}%\n- Reason: ${candidate.reason}`;
	if (fs.existsSync(filePath)) {
		const existing = readFileSafe(filePath) ?? "";
		fs.writeFileSync(filePath, `${existing}\n\n---\n\n## Update (${nowTimestamp()})\n\n${body}\n`, "utf-8");
		return { rel: path.relative(activePackPath, filePath), action: "updated" };
	}
	fs.writeFileSync(filePath, buildNote(activePack, candidate.type, candidate.title, body, candidate.tags), "utf-8");
	return { rel: path.relative(activePackPath, filePath), action: "created" };
}

// ---------------------------------------------------------------------------
// Vault / packs path resolution
// ---------------------------------------------------------------------------

/**
 * Default global packs directory: ~/.pi/agent/memory-vault/packs
 */
const DEFAULT_GLOBAL_PACKS_DIR = path.join(
	process.env.HOME ?? process.env.USERPROFILE ?? "~",
	".pi",
	"agent",
	"memory-vault",
	"packs",
);

/**
 * Resolve the packs directory using a priority chain:
 *
 *   1. MEMCTX_PACKS_PATH env var           — explicit override
 *   2. .pi/memory-vault/packs/          — project-local (relative to cwd)
 *   3. ~/.pi/agent/memory-vault/packs/  — global default
 *   4. <package-root>/packs/            — fallback for development
 *
 * Returns the first path that exists and contains at least one pack.
 */
export function resolvePacksDir(cwd: string): string | null {
	const candidates: { label: string; dir: string }[] = [];

	// 1. Explicit env var
	if (process.env.MEMCTX_PACKS_PATH) {
		candidates.push({ label: "MEMCTX_PACKS_PATH", dir: process.env.MEMCTX_PACKS_PATH });
	}

	// 2. Project-local: <cwd>/.pi/memory-vault/packs/
	candidates.push({
		label: "project-local",
		dir: path.join(cwd, ".pi", "memory-vault", "packs"),
	});

	// 3. Global default: ~/.pi/agent/memory-vault/packs/
	candidates.push({ label: "global", dir: DEFAULT_GLOBAL_PACKS_DIR });

	// 4. Package root fallback (development): <package>/packs/
	const packageRoot = findVaultRoot(path.resolve(__dirname, "../.."));
	if (packageRoot) {
		candidates.push({ label: "package-root", dir: path.join(packageRoot, "packs") });
	}

	// Return first candidate that exists and has packs
	for (const { dir } of candidates) {
		if (listPacks(dir).length > 0) {
			return dir;
		}
	}

	return null;
}


type EvidenceFile = {
	path: string;
	content: string;
};

type RepoEvidence = {
	name: string;
	slug: string;
	path: string;
	type: string;
	status: "active" | "placeholder";
	description: string;
	remote: string;
	currentBranch: string;
	readFirst: string[];
	packageManager: string;
	scripts: Record<string, string>;
	safeCommands: string[];
	docs: EvidenceFile[];
	workflows: EvidenceFile[];
	infra: string[];
	tree: string[];
	observations: string[];
};

const REPO_HIDDEN_ALLOWLIST = new Set([".github", ".gitlab"]);
const SKIP_DIRS = new Set([
	".git",
	"node_modules",
	"vendor",
	"dist",
	"build",
	"out",
	"coverage",
	".cache",
	".next",
	".turbo",
]);
const SENSITIVE_FILE_RE = /(^|\/)(\.env(\..*)?|.*\.(pem|key|p12|pfx)|id_rsa|id_ed25519|credentials?|secrets?\..*)$/i;
const SECRET_VALUE_PATTERNS = [
	/AKIA[0-9A-Z]{16}/g,
	/-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
	/(authorization\s*:\s*bearer\s+)[^\s`'"<>]+/gi,
	/((?:api[_-]?key|secret|token|password|passwd|pwd)\s*[:=]\s*)[^\s`'"<>]+/gi,
];

function safeExecGit(repoPath: string, args: string[]): string {
	try {
		return execFileSync("git", ["-C", repoPath, ...args], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 2000,
		}).trim();
	} catch {
		return "";
	}
}

function sanitizeEvidence(text: string): string {
	let sanitized = text;
	for (const pattern of SECRET_VALUE_PATTERNS) {
		sanitized = sanitized.replace(pattern, (_match, prefix = "") => `${prefix}[REDACTED_SECRET]`);
	}
	return sanitized;
}

function readEvidenceFile(filePath: string, repoPath: string, maxChars = 4000): EvidenceFile | null {
	const rel = path.relative(repoPath, filePath);
	if (SENSITIVE_FILE_RE.test(rel)) return null;
	const content = readFileSafe(filePath);
	if (!content?.trim()) return null;
	return { path: rel, content: truncate(sanitizeEvidence(content.trim()), maxChars) };
}

function listTopLevelEntries(dirPath: string, limit = 60): string[] {
	try {
		return fs.readdirSync(dirPath, { withFileTypes: true })
			.filter((e) => !SKIP_DIRS.has(e.name) && !SENSITIVE_FILE_RE.test(e.name))
			.map((e) => e.isDirectory() ? `${e.name}/` : e.name)
			.sort()
			.slice(0, limit);
	} catch {
		return [];
	}
}

function findFilesLimited(root: string, predicate: (rel: string, name: string) => boolean, limit = 20, maxDepth = 4): string[] {
	const found: string[] = [];
	function walk(dir: string, depth: number) {
		if (found.length >= limit || depth > maxDepth) return;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (found.length >= limit) break;
			if (SKIP_DIRS.has(entry.name)) continue;
			const full = path.join(dir, entry.name);
			const rel = path.relative(root, full);
			if (SENSITIVE_FILE_RE.test(rel)) continue;
			if (entry.isDirectory()) {
				walk(full, depth + 1);
			} else if (predicate(rel, entry.name)) {
				found.push(full);
			}
		}
	}
	walk(root, 0);
	return found.sort();
}

function repoSlugForName(name: string): string {
	if (name === ".github") return "github-profile";
	return slugify(name) || "repo";
}

function detectPackageManager(repoPath: string): string {
	if (fs.existsSync(path.join(repoPath, "pnpm-lock.yaml"))) return "pnpm";
	if (fs.existsSync(path.join(repoPath, "bun.lock")) || fs.existsSync(path.join(repoPath, "bun.lockb"))) return "bun";
	if (fs.existsSync(path.join(repoPath, "yarn.lock"))) return "yarn";
	if (fs.existsSync(path.join(repoPath, "package-lock.json"))) return "npm";
	return "npm";
}

function scriptCommand(pm: string, script: string): string {
	if (script === "install") {
		if (pm === "pnpm") return "pnpm install --frozen-lockfile";
		if (pm === "bun") return "bun install --frozen-lockfile";
		if (pm === "yarn") return "yarn install --frozen-lockfile";
		return "npm ci";
	}
	if (pm === "pnpm") return `pnpm ${script}`;
	if (pm === "bun") return `bun run ${script}`;
	if (pm === "yarn") return `yarn ${script}`;
	return `npm run ${script}`;
}

function isSafeScriptName(name: string): boolean {
	return !/(deploy|destroy|delete|remove|apply|publish|release|prod|production|push|login|secret|token)/i.test(name);
}

function collectPackageEvidence(repoPath: string): { type: string; description: string; scripts: Record<string, string>; packageManager: string; commands: string[]; observations: string[] } {
	const packagePath = path.join(repoPath, "package.json");
	if (!fs.existsSync(packagePath)) return { type: "", description: "", scripts: {}, packageManager: "", commands: [], observations: [] };
	try {
		const pkg = JSON.parse(readFileSafe(packagePath) ?? "{}");
		const packageManager = detectPackageManager(repoPath);
		const scripts: Record<string, string> = pkg.scripts ?? {};
		const commands = [scriptCommand(packageManager, "install")];
		for (const name of Object.keys(scripts)) {
			if (isSafeScriptName(name) && /^(dev|start|build|test|lint|typecheck|check|ci|format|e2e)$/i.test(name)) {
				commands.push(scriptCommand(packageManager, name));
			}
		}
		const deps = Object.keys(pkg.dependencies ?? {}).slice(0, 12);
		const devDeps = Object.keys(pkg.devDependencies ?? {}).slice(0, 12);
		const observations = [
			`Package name: ${pkg.name ?? path.basename(repoPath)}`,
			pkg.version ? `Package version: ${pkg.version}` : "",
			deps.length ? `Runtime dependencies include: ${deps.join(", ")}` : "",
			devDeps.length ? `Development dependencies include: ${devDeps.join(", ")}` : "",
		].filter(Boolean);
		return {
			type: "Node/TS",
			description: pkg.description ?? pkg.name ?? "",
			scripts,
			packageManager,
			commands,
			observations,
		};
	} catch {
		return { type: "Node/TS", description: "", scripts: {}, packageManager: detectPackageManager(repoPath), commands: [], observations: ["package.json exists but could not be parsed."] };
	}
}

function collectGoEvidence(repoPath: string): { type: string; description: string; commands: string[]; observations: string[] } {
	const gomodPath = path.join(repoPath, "go.mod");
	if (!fs.existsSync(gomodPath)) return { type: "", description: "", commands: [], observations: [] };
	const gomod = readFileSafe(gomodPath) ?? "";
	const moduleLine = gomod.match(/^module\s+(.+)$/m)?.[1] ?? "";
	const goVersion = gomod.match(/^go\s+(.+)$/m)?.[1] ?? "";
	return {
		type: "Go",
		description: moduleLine,
		commands: ["go test ./...", "go build ./..."],
		observations: [moduleLine ? `Go module: ${moduleLine}` : "Go module observed.", goVersion ? `Go version: ${goVersion}` : ""].filter(Boolean),
	};
}

function collectMakeCommands(repoPath: string): string[] {
	const makefile = readFileSafe(path.join(repoPath, "Makefile")) ?? readFileSafe(path.join(repoPath, "makefile"));
	if (!makefile) return [];
	const commands: string[] = [];
	for (const match of makefile.matchAll(/^([a-zA-Z0-9_.-]+):(?:\s|$)/gm)) {
		const target = match[1];
		if (isSafeScriptName(target) && /^(test|build|lint|check|format|dev|run)$/i.test(target)) {
			commands.push(`make ${target}`);
		}
	}
	return commands;
}

function extractFirstMeaningfulLine(content: string): string {
	return content.split("\n")
		.map((line) => line.trim())
		.find((line) => line && !line.startsWith("#") && !line.startsWith("<") && !line.startsWith("[") && !line.startsWith("!"))
		?.slice(0, 200) ?? "";
}

function collectRepoEvidence(repoPath: string, name: string): RepoEvidence {
	const slug = repoSlugForName(name);
	const topLevel = listTopLevelEntries(repoPath);
	const nonGitEntries = topLevel.filter((entry) => entry !== ".git/");
	const isPlaceholder = nonGitEntries.length === 0;
	const pkg = collectPackageEvidence(repoPath);
	const go = collectGoEvidence(repoPath);
	const hasTerraform = fs.existsSync(path.join(repoPath, "terraform")) || findFilesLimited(repoPath, (rel) => rel.endsWith(".tf"), 3, 3).length > 0;
	const hasInfra = fs.existsSync(path.join(repoPath, "infra")) || fs.existsSync(path.join(repoPath, "charts")) || fs.existsSync(path.join(repoPath, "helm"));
	let type = pkg.type || go.type || (hasTerraform || hasInfra ? "IaC" : "unknown");
	if (name === ".github") type = "GitHub profile/docs";

	const docs: EvidenceFile[] = [];
	const docNames = ["AGENTS.md", "CLAUDE.md", "README.md", "CONTRIBUTING.md", "SECURITY.md", "CHANGELOG.md", "SUPPORT.md"];
	for (const docName of docNames) {
		const doc = readEvidenceFile(path.join(repoPath, docName), repoPath, docName === "README.md" ? 5000 : 3000);
		if (doc) docs.push(doc);
	}
	for (const docPath of findFilesLimited(path.join(repoPath, "docs"), (rel, file) => file.endsWith(".md"), 12, 3)) {
		const doc = readEvidenceFile(docPath, repoPath, 2500);
		if (doc && !docs.some((d) => d.path === doc.path)) docs.push(doc);
	}
	if (name === ".github") {
		const profile = readEvidenceFile(path.join(repoPath, "profile", "README.md"), repoPath, 5000);
		if (profile) docs.push(profile);
	}

	const workflows = findFilesLimited(path.join(repoPath, ".github", "workflows"), (rel, file) => /\.(ya?ml)$/.test(file), 10, 1)
		.map((f) => readEvidenceFile(f, repoPath, 2000))
		.filter((f): f is EvidenceFile => Boolean(f));
	const infra = [
		...findFilesLimited(repoPath, (rel) => /(^|\/)(Dockerfile|docker-compose\.ya?ml|compose\.ya?ml)$/.test(rel), 10, 3),
		...findFilesLimited(repoPath, (rel) => /(^|\/)(terraform|infra|helm|charts|k8s|kubernetes)\//.test(rel) && /\.(tf|ya?ml|yaml|json|md)$/.test(rel), 15, 4),
	].map((f) => path.relative(repoPath, f));

	const readFirst = docs
		.map((d) => d.path)
		.filter((name) => ["AGENTS.md", "CLAUDE.md", "README.md", "profile/README.md", "CONTRIBUTING.md", "SECURITY.md"].includes(name))
		.slice(0, 8);
	const readme = docs.find((d) => d.path === "README.md" || d.path === "profile/README.md");
	const description = pkg.description || go.description || (readme ? extractFirstMeaningfulLine(readme.content) : "") || name;
	const safeCommands = Array.from(new Set([
		...pkg.commands,
		...go.commands,
		...collectMakeCommands(repoPath),
	]));
	const observations = Array.from(new Set([
		...pkg.observations,
		...go.observations,
		workflows.length ? `GitHub Actions workflows observed: ${workflows.map((w) => w.path).join(", ")}` : "",
		infra.length ? `Infrastructure/config files observed: ${infra.slice(0, 8).join(", ")}` : "",
		isPlaceholder ? "Repository appears to be empty/placeholder; only Git metadata or no source files observed." : "",
	].filter(Boolean)));

	return {
		name,
		slug,
		path: repoPath,
		type,
		status: isPlaceholder ? "placeholder" : "active",
		description,
		remote: safeExecGit(repoPath, ["remote", "get-url", "origin"]) || "unknown/not configured",
		currentBranch: safeExecGit(repoPath, ["branch", "--show-current"]) || "unknown",
		readFirst,
		packageManager: pkg.packageManager,
		scripts: pkg.scripts,
		safeCommands,
		docs,
		workflows,
		infra,
		tree: topLevel,
		observations,
	};
}

function discoverRepositories(scanDir: string): RepoEvidence[] {
	if (!fs.existsSync(scanDir)) return [];
	return fs.readdirSync(scanDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.filter((entry) => !entry.name.startsWith(".") || REPO_HIDDEN_ALLOWLIST.has(entry.name))
		.filter((entry) => !SKIP_DIRS.has(entry.name))
		.map((entry) => collectRepoEvidence(path.join(scanDir, entry.name), entry.name))
		.sort((a, b) => a.name.localeCompare(b.name));
}

function yamlList(items: string[]): string {
	return items.length ? items.map((i) => `  - ${i}`).join("\n") : "  - none";
}

function writeGeneratedFile(packPath: string, relPath: string, content: string, filesCreated: string[]): void {
	const filePath = path.join(packPath, relPath);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content.trimEnd() + "\n", "utf-8");
	filesCreated.push(filePath);
}

type RepoFileInventoryItem = {
	path: string;
	size: number;
	language: string;
	imports: string[];
	exports: string[];
	symbols: string[];
};

type LlmFileSelection = {
	files?: string[];
	reasons?: Record<string, string>;
};

type LlmRepoSynthesis = {
	summary?: string;
	architecture?: unknown;
	entrypoints?: unknown;
	domains?: unknown;
	integrations?: unknown;
	envVars?: unknown;
	risks?: unknown;
	testing?: unknown;
};

function detectLanguage(rel: string): string {
	const ext = path.extname(rel).toLowerCase();
	if ([".ts", ".tsx"].includes(ext)) return "typescript";
	if ([".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return "javascript";
	if (ext === ".go") return "go";
	if (ext === ".py") return "python";
	if ([".yml", ".yaml"].includes(ext)) return "yaml";
	if (ext === ".json") return "json";
	if (ext === ".md") return "markdown";
	if (ext === ".tf") return "terraform";
	return ext.replace(/^\./, "") || "text";
}

function collectRepoFileInventory(repoPath: string, limit = 180): RepoFileInventoryItem[] {
	const candidates = findFilesLimited(repoPath, (rel, name) => {
		if (rel.includes("/node_modules/") || SENSITIVE_FILE_RE.test(rel)) return false;
		return /\.(ts|tsx|js|jsx|mjs|cjs|go|py|json|ya?ml|md|tf|dockerfile)$/i.test(name)
			|| ["Dockerfile", "Makefile", "package.json", "go.mod", "compose.yml", "docker-compose.yml"].includes(name);
	}, limit, 7);
	return candidates.map((full) => {
		const rel = path.relative(repoPath, full);
		const content = readFileSafe(full) ?? "";
		return {
			path: rel,
			size: Buffer.byteLength(content, "utf-8"),
			language: detectLanguage(rel),
			imports: [...content.matchAll(/^\s*import\s+.*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]).slice(0, 12),
			exports: [...content.matchAll(/^\s*export\s+(?:default\s+)?(?:class|function|const|interface|type)\s+([A-Za-z0-9_]+)/gm)].map((m) => m[1]).slice(0, 20),
			symbols: [...content.matchAll(/^\s*(?:class|function|const|interface|type|func)\s+([A-Za-z0-9_]+)/gm)].map((m) => m[1]).slice(0, 20),
		};
	}).sort((a, b) => {
		const rank = (item: RepoFileInventoryItem) => /(^|\/)(package\.json|go\.mod|README\.md|AGENTS\.md|CLAUDE\.md|Dockerfile|docker-compose\.ya?ml)$/.test(item.path) ? 0 : item.path.split("/").length;
		return rank(a) - rank(b) || a.path.localeCompare(b.path);
	});
}

function extractImportantSnippet(repoPath: string, rel: string, maxChars = 5000): string {
	const file = readEvidenceFile(path.join(repoPath, rel), repoPath, maxChars);
	if (!file) return "";
	const lines = file.content.split("\n");
	const important = lines.filter((line, idx) => {
		if (idx < 80) return true;
		return /\b(import|export|class|function|interface|type|router|route|controller|service|process\.env|env\.|DATABASE|REDIS|STRIPE|JWT|AUTH|PORT)\b/i.test(line);
	});
	return truncate(important.join("\n"), maxChars);
}

async function selectImportantFilesWithLlm(repo: RepoEvidence, inventory: RepoFileInventoryItem[], ctx: ExtensionContext): Promise<string[]> {
	const fallback = inventory.slice(0, 24).map((f) => f.path);
	if (llmMode === "off" || !ctx.model || inventory.length === 0) return fallback;
	const decision = await completeJsonWithLlm<LlmFileSelection>(ctx, "pack-generate-select-files", [
		"Select the most important files for understanding a repository.",
		"Prioritize architecture, entrypoints, API surface, data model, integrations, config, deployment, tests.",
		"Return ONLY JSON: {\"files\":[...], \"reasons\":{\"path\":\"short reason\"}}. Max 24 files.",
	].join("\n"), {
		repo: { name: repo.name, type: repo.type, scripts: repo.scripts, tree: repo.tree.slice(0, 80) },
		inventory: inventory.slice(0, 160),
	});
	const selected = (decision?.files ?? []).filter((f) => inventory.some((i) => i.path === f)).slice(0, 24);
	return selected.length ? selected : fallback;
}

async function synthesizeRepoWithLlm(repo: RepoEvidence, selectedFiles: string[], ctx: ExtensionContext): Promise<LlmRepoSynthesis | null> {
	if (llmMode === "off" || !ctx.model) return null;
	const snippets = selectedFiles.map((file) => ({ file, snippet: extractImportantSnippet(repo.path, file, 3500) })).filter((f) => f.snippet.trim());
	if (snippets.length === 0) return null;
	return completeJsonWithLlm<LlmRepoSynthesis>(ctx, "pack-generate-synthesize-repo", [
		"You synthesize durable memory-pack notes from redacted source evidence.",
		"Only make claims supported by file evidence. Mention unknown when evidence is insufficient.",
		"Return ONLY compact JSON with keys: summary, architecture[], entrypoints[], domains[], integrations[], envVars[], risks[], testing[].",
		"Do not include secret values. Env var names are allowed; values are not.",
	].join("\n"), {
		repo: { name: repo.name, type: repo.type, path: repo.path, scripts: repo.scripts, safeCommands: repo.safeCommands },
		files: snippets,
	});
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((item) => typeof item === "string" ? item : item == null ? "" : String(item))
		.map((item) => item.trim())
		.filter(Boolean);
}

function asDomainRows(value: unknown): string {
	if (!Array.isArray(value) || value.length === 0) return "| unknown | Insufficient evidence. | - |";
	const rows = value.map((item) => {
		if (!item || typeof item !== "object") return null;
		const domain = item as { name?: unknown; responsibility?: unknown; files?: unknown };
		const name = typeof domain.name === "string" && domain.name.trim() ? domain.name.trim() : "unknown";
		const responsibility = typeof domain.responsibility === "string" && domain.responsibility.trim()
			? domain.responsibility.trim()
			: "Insufficient evidence.";
		const files = asStringArray(domain.files).map((f) => `\`${f}\``).join(", ") || "-";
		return `| ${name} | ${responsibility} | ${files} |`;
	}).filter(Boolean);
	return rows.length ? rows.join("\n") : "| unknown | Insufficient evidence. | - |";
}

export function llmArchitectureNote(packSlug: string, repo: RepoEvidence, synthesis: LlmRepoSynthesis, selectedFiles: string[], today: string): string {
	const domains = asDomainRows(synthesis.domains);
	const architecture = asStringArray(synthesis.architecture);
	const entrypoints = asStringArray(synthesis.entrypoints);
	const integrations = asStringArray(synthesis.integrations);
	const envVars = asStringArray(synthesis.envVars);
	const risks = asStringArray(synthesis.risks);
	const testing = asStringArray(synthesis.testing);
	return `---
type: context-pack
id: context.${packSlug}.${repo.slug}.llm-architecture
title: ${repo.name} LLM Architecture
status: active
source_of_truth: false
freshness: current
last_reviewed: ${today}
tags:
  - pack/${packSlug}
  - agent-memory/context-pack
  - repo/${repo.slug}
  - llm-generated
---

# ${repo.name} LLM Architecture

Generated from redacted source evidence. Validate behavior against source files before making changes.

## Summary

${synthesis.summary || repo.description}

## Key files analyzed

${selectedFiles.map((f) => `- \`${f}\``).join("\n") || "- No files selected."}

## Architecture

${(architecture.length ? architecture : repo.observations).map((x) => `- ${x}`).join("\n") || "- Unknown from available evidence."}

## Entry points

${entrypoints.map((x) => `- ${x}`).join("\n") || "- Unknown from available evidence."}

## Domains

| Domain | Responsibility | Evidence files |
|---|---|---|
${domains}

## Integrations

${integrations.map((x) => `- ${x}`).join("\n") || "- No high-confidence integrations identified."}

## Environment variables referenced

${envVars.map((x) => `- \`${x}\``).join("\n") || "- No environment variables identified from selected evidence."}

## Risks and follow-ups

${risks.map((x) => `- ${x}`).join("\n") || "- No specific risks identified from selected evidence."}

## Testing notes

${testing.map((x) => `- ${x}`).join("\n") || "- Inspect repository tests and CI before changing behavior."}

## Related

- [[packs/${packSlug}/20-context/${repo.slug}|${repo.name} context]]
- [[packs/${packSlug}/00-system/indexes/context-index|Context Index]]
`;
}

async function enrichGeneratedPackWithLlm(scanDir: string, packSlug: string, packPath: string, ctx: ExtensionContext): Promise<string[]> {
	const filesCreated: string[] = [];
	const today = todayStr();
	const repos = discoverRepositories(scanDir).filter((repo) => repo.status === "active").slice(0, 12);
	const contextRows: string[] = [];
	if (ctx.hasUI) ctx.ui.notify(`memctx enrich: discovered ${repos.length} active repos.`, "info");
	for (const repo of repos) {
		if (ctx.hasUI) ctx.ui.notify(`memctx enrich: repo ${repo.name}: collecting inventory...`, "info");
		const inventory = collectRepoFileInventory(repo.path);
		const selected = await selectImportantFilesWithLlm(repo, inventory, ctx);
		if (llmMode === "off" || !ctx.model) {
			if (ctx.hasUI) ctx.ui.notify(`memctx enrich: repo ${repo.name}: LLM architecture skipped (llm:${llmMode}).`, "info");
			continue;
		}
		if (ctx.hasUI) ctx.ui.notify(`memctx enrich: repo ${repo.name}: synthesizing architecture from ${selected.length} files...`, "info");
		const synthesis = await synthesizeRepoWithLlm(repo, selected, ctx);
		if (!synthesis) {
			if (ctx.hasUI) ctx.ui.notify(`memctx enrich: repo ${repo.name}: no LLM synthesis produced.`, "warning");
			continue;
		}
		const rel = `20-context/${repo.slug}-llm-architecture.md`;
		writeGeneratedFile(packPath, rel, llmArchitectureNote(packSlug, repo, synthesis, selected, today), filesCreated);
		if (ctx.hasUI) ctx.ui.notify(`memctx enrich: repo ${repo.name}: wrote ${rel}.`, "info");
		contextRows.push(`| [[packs/${packSlug}/20-context/${repo.slug}-llm-architecture|${repo.name} LLM Architecture]] | LLM-assisted architecture synthesized from selected source evidence. |`);
	}
	if (contextRows.length) {
		const indexPath = path.join(packPath, "00-system/indexes/context-index.md");
		const existing = readFileSafe(indexPath);
		if (existing) {
			fs.writeFileSync(indexPath, `${existing.trim()}\n${contextRows.join("\n")}\n`, "utf-8");
			filesCreated.push(indexPath);
		}
	}
	await enrichQmdEconomyFactCardsWithQmd(packSlug, packPath, filesCreated, (message) => {
		if (ctx.hasUI) ctx.ui.notify(message, "info");
	});
	return filesCreated;
}

function repoContextNote(packSlug: string, repo: RepoEvidence, today: string): string {
	const docs = repo.docs.slice(0, 8).map((d) => `### ${d.path}\n\n${d.content}`).join("\n\n");
	const scripts = Object.keys(repo.scripts).length
		? Object.entries(repo.scripts).map(([name, cmd]) => `| ${name} | \`${sanitizeEvidence(cmd)}\` |`).join("\n")
		: "| none observed |  |";
	const workflows = repo.workflows.length
		? repo.workflows.map((w) => `### ${w.path}\n\n${w.content}`).join("\n\n")
		: "No GitHub Actions workflows observed.";
	return `---
type: context-pack
id: context.${packSlug}.${repo.slug}
title: ${repo.name}
status: active
source_of_truth: false
freshness: current
last_reviewed: ${today}
tags:
  - pack/${packSlug}
  - agent-memory/context-pack
  - repo/${repo.slug}
---

# ${repo.name}

**Type:** ${repo.type}  
**Status:** ${repo.status}  
**Description:** ${repo.description}  
**Local path:** \`${repo.path}\`  
**Remote:** \`${repo.remote}\`  
**Current branch:** \`${repo.currentBranch}\`

## Read first

${repo.readFirst.length ? repo.readFirst.map((f) => `- \`${f}\``).join("\n") : "- Inspect repository source before assuming conventions."}

## Safe commands observed

${repo.safeCommands.length ? repo.safeCommands.map((c) => `- \`${c}\``).join("\n") : "No safe development commands inferred."}

## Package scripts

| Script | Command |
|---|---|
${scripts}

## Observations

${repo.observations.length ? repo.observations.map((o) => `- ${o}`).join("\n") : "- No high-confidence observations generated."}

## Workflows

${workflows}

## Directory structure

\`\`\`txt
${repo.tree.join("\n") || "<empty>"}
\`\`\`

## Source excerpts

${docs || "No documentation excerpts observed."}

## Related

- [[packs/${packSlug}/00-system/pi-agent/resource-map|Resource Map]]
- [[packs/${packSlug}/00-system/indexes/context-index|Context Index]]
`;
}

function repoProjectNote(packSlug: string, repo: RepoEvidence, today: string): string {
	return `---
type: project
id: project.${packSlug}.${repo.slug}
title: ${repo.name}
status: ${repo.status === "placeholder" ? "draft" : "active"}
source_of_truth: false
freshness: current
last_reviewed: ${today}
tags:
  - pack/${packSlug}
  - agent-memory/project
  - repo/${repo.slug}
---

# ${repo.name}

## Repository

| Field | Value |
|---|---|
| Local path | \`${repo.path}\` |
| Remote | \`${repo.remote}\` |
| Type | ${repo.type} |
| Status | ${repo.status} |
| Current branch | \`${repo.currentBranch}\` |

## Purpose

${repo.description}

## Read-first files

${repo.readFirst.length ? repo.readFirst.map((f) => `- \`${f}\``).join("\n") : "- No read-first files observed."}

## Related

- [[packs/${packSlug}/20-context/${repo.slug}|${repo.name} context]]
- [[packs/${packSlug}/00-system/indexes/project-index|Project Index]]
`;
}

function repoRunbookNote(packSlug: string, repo: RepoEvidence, today: string): string {
	return `---
type: runbook
id: runbook.${packSlug}.${repo.slug}.development
-title: ${repo.name} Development Runbook
status: active
source_of_truth: false
freshness: current
last_reviewed: ${today}
tags:
  - pack/${packSlug}
  - agent-memory/runbook
  - repo/${repo.slug}
---

# ${repo.name} Development Runbook

Use source-of-truth files in \`${repo.path}\` before changing behavior. The commands below were inferred from manifests and safe script names only.

## Setup and checks

${repo.safeCommands.map((c) => `- \`${c}\``).join("\n")}

## Notes

- Destructive, deploy, release, publish, production, and credential-related commands are intentionally excluded from generated runbooks.
- If a command fails, inspect the repository README, AGENTS.md, package manifest, Makefile, and CI workflows.

## Related

- [[packs/${packSlug}/20-context/${repo.slug}|${repo.name} context]]
- [[packs/${packSlug}/00-system/indexes/runbook-index|Runbook Index]]
`;
}

/**
 * Scan a directory tree and generate a pack from its contents.
 * Performs deterministic discovery of repositories, docs, stacks, scripts,
 * workflows, git remotes, safe development commands, and source-truth pointers.
 */
export function generatePackFromDirectory(
	scanDir: string,
	packSlug: string,
	packsDir: string,
): { packPath: string; filesCreated: string[] } {
	const packPath = path.join(packsDir, packSlug);
	const filesCreated: string[] = [];
	const today = todayStr();
	const title = packSlug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

	for (const dir of [
		"00-system/pi-agent",
		"00-system/indexes",
		"00-system/local",
		"10-user",
		"20-context",
		"30-projects",
		"40-actions",
		"50-decisions",
		"60-observations",
		"70-runbooks",
		"80-sessions",
	]) {
		fs.mkdirSync(path.join(packPath, dir), { recursive: true });
	}

	const repos = discoverRepositories(scanDir);
	const contextEntries: string[] = [];
	const projectEntries: string[] = [];
	const runbookEntries: string[] = [];

	writeGeneratedFile(packPath, "00-system/pi-agent/memory-manifest.md", `---
type: system
id: system.${packSlug}.memory-manifest
title: ${title} Memory Manifest
status: active
source_of_truth: true
freshness: current
last_reviewed: ${today}
tags:
  - agent-memory/system
  - pack/${packSlug}
---

# ${title} Memory Manifest

This pack stores safe durable context generated from \`${scanDir}\`.

## Pack root

\`packs/${packSlug}\`

## Entry order

1. [[packs/${packSlug}/00-system/pi-agent/retrieval-protocol|Retrieval Protocol]]
2. [[packs/${packSlug}/00-system/pi-agent/resource-map|Resource Map]]
3. Relevant indexes under \`00-system/indexes/\`
4. Context and project notes generated from repository source files
5. Source-of-truth repository files when behavior matters

## Indexes

- [[packs/${packSlug}/00-system/indexes/context-index|Context Index]]
- [[packs/${packSlug}/00-system/indexes/project-index|Project Index]]
- [[packs/${packSlug}/00-system/indexes/action-index|Action Index]]
- [[packs/${packSlug}/00-system/indexes/decision-index|Decision Index]]
- [[packs/${packSlug}/00-system/indexes/observation-index|Observation Index]]
- [[packs/${packSlug}/00-system/indexes/runbook-index|Runbook Index]]
- [[packs/${packSlug}/00-system/indexes/session-index|Session Index]]

## Safety

Generated content is sanitized with high-confidence secret redaction. Never store secrets, credentials, private keys, tokens, customer data, or sensitive payloads.
`, filesCreated);

	writeGeneratedFile(packPath, "00-system/pi-agent/retrieval-protocol.md", `---
type: system
id: system.${packSlug}.retrieval-protocol
title: Retrieval Protocol
status: active
source_of_truth: true
freshness: current
last_reviewed: ${today}
tags:
  - agent-memory/retrieval
  - pack/${packSlug}
---

# Retrieval Protocol

Before working with repositories from \`${scanDir}\`:

1. Read [[packs/${packSlug}/00-system/pi-agent/resource-map|Resource Map]].
2. Read the repository-specific context note in \`20-context/\`.
3. Read repository-local source-of-truth instructions such as \`AGENTS.md\`, \`CLAUDE.md\`, \`README.md\`, \`CONTRIBUTING.md\`, and relevant docs.
4. Use generated runbooks only as safe starting points; source files, tests, CI, and live runtime facts win.
5. Do not persist or expose secrets, credentials, customer data, or sensitive payloads.
`, filesCreated);

	const repoRows = repos.map((r) => `| \`${r.name}\` | ${r.type} | ${r.status} | \`${r.path}\` | \`${r.remote}\` | ${r.readFirst.map((f) => `\`${f}\``).join(", ") || "inspect source"} |`).join("\n");
	writeGeneratedFile(packPath, "00-system/pi-agent/resource-map.md", `---
type: system
id: system.${packSlug}.resource-map
title: Resource Map
status: active
source_of_truth: true
freshness: current
last_reviewed: ${today}
tags:
  - agent-memory/resources
  - pack/${packSlug}
---

# Resource Map

## Source directory

\`${scanDir}\`

## Repositories

| Name | Type | Status | Local path | Remote | Read first |
|---|---|---|---|---|---|
${repoRows || "| none observed | unknown | placeholder | - | - | - |"}

## Safety

- Treat generated notes as context, not authority.
- Source-of-truth files in repositories override memory notes.
- Secret-like values are redacted as \`[REDACTED_SECRET]\` before persistence.
`, filesCreated);

	writeGeneratedFile(packPath, "20-context/overview.md", `---
type: context-pack
id: context.${packSlug}.overview
title: ${title} Overview
status: active
source_of_truth: false
freshness: current
last_reviewed: ${today}
tags:
  - pack/${packSlug}
  - agent-memory/context-pack
---

# ${title} Overview

Generated from \`${scanDir}\`.

## Repositories

${repos.map((r) => `- [[packs/${packSlug}/20-context/${r.slug}|${r.name}]] — ${r.type}, ${r.status}, ${r.description}`).join("\n") || "No repositories observed."}

## Related

- [[packs/${packSlug}/00-system/pi-agent/resource-map|Resource Map]]
- [[packs/${packSlug}/00-system/indexes/context-index|Context Index]]
`, filesCreated);
	contextEntries.push(`| [[packs/${packSlug}/20-context/overview|${title} Overview]] | Workspace overview generated from ${scanDir}. |`);

	for (const repo of repos) {
		writeGeneratedFile(packPath, `20-context/${repo.slug}.md`, repoContextNote(packSlug, repo, today), filesCreated);
		writeGeneratedFile(packPath, `30-projects/${repo.slug}.md`, repoProjectNote(packSlug, repo, today), filesCreated);
		contextEntries.push(`| [[packs/${packSlug}/20-context/${repo.slug}|${repo.name}]] | ${repo.type} — ${repo.description.slice(0, 80)} |`);
		projectEntries.push(`| [[packs/${packSlug}/30-projects/${repo.slug}|${repo.name}]] | ${repo.status} ${repo.type} repository. |`);
		if (repo.safeCommands.length > 0) {
			writeGeneratedFile(packPath, `70-runbooks/${repo.slug}-development.md`, repoRunbookNote(packSlug, repo, today).replace("\n-title:", "\ntitle:"), filesCreated);
			runbookEntries.push(`| [[packs/${packSlug}/70-runbooks/${repo.slug}-development|${repo.name} Development Runbook]] | Safe generated setup/check commands. |`);
		}
	}

	writeGeneratedFile(packPath, "60-observations/workspace-repository-map.md", `---
type: observation
id: observation.${packSlug}.workspace-repository-map
title: Workspace Repository Map
status: active
source_of_truth: false
freshness: current
last_reviewed: ${today}
tags:
  - pack/${packSlug}
  - agent-memory/observation
---

# Workspace Repository Map

## Generated discovery

| Repository | Type | Status | Observations |
|---|---|---|---|
${repos.map((r) => `| ${r.name} | ${r.type} | ${r.status} | ${r.observations.slice(0, 3).join("<br>") || "No generated observations."} |`).join("\n") || "| none | unknown | placeholder | No repositories observed. |"}

## Related

- [[packs/${packSlug}/00-system/pi-agent/resource-map|Resource Map]]
- [[packs/${packSlug}/00-system/indexes/observation-index|Observation Index]]
`, filesCreated);

	const indexSpecs: Array<[string, string, string[]]> = [
		["context-index.md", "Context Index", contextEntries],
		["project-index.md", "Project Index", projectEntries],
		["action-index.md", "Action Index", ["| <Add wikilink> | <Purpose> |"]],
		["decision-index.md", "Decision Index", ["| <Add wikilink> | <Purpose> |"]],
		["observation-index.md", "Observation Index", [`| [[packs/${packSlug}/60-observations/workspace-repository-map|Workspace Repository Map]] | Generated repository discovery observations. |`]],
		["runbook-index.md", "Runbook Index", runbookEntries.length ? runbookEntries : ["| <Add wikilink> | <Purpose> |"]],
		["session-index.md", "Session Index", ["| <Add wikilink> | <Purpose> |"]],
	];
	generateQmdEconomyFactCards(packSlug, packPath, filesCreated);

	for (const [filename, heading, rows] of indexSpecs) {
		writeGeneratedFile(packPath, `00-system/indexes/${filename}`, `---
type: index
id: index.${packSlug}.${filename.replace(/\.md$/, "")}
title: ${heading}
status: active
source_of_truth: true
freshness: current
last_reviewed: ${today}
tags:
  - agent-memory/index
  - pack/${packSlug}
---

# ${heading}

| Note | Use |
|---|---|
${rows.join("\n")}
`, filesCreated);
	}

	return { packPath, filesCreated };
}

function looksLikeProjectDirectory(cwd: string): boolean {
	const basename = path.basename(cwd);
	if (!cwd || cwd === path.parse(cwd).root) return false;
	if (["", "~", "home", "users", "downloads", "desktop", "documents"].includes(basename.toLowerCase())) return false;
	const signals = [".git", "package.json", "go.mod", "README.md", "pyproject.toml", "Cargo.toml", "docker-compose.yml", "pnpm-workspace.yaml"];
	return signals.some((signal) => fs.existsSync(path.join(cwd, signal)));
}

async function maybeBootstrapPack(ctx: ExtensionContext, packsDir: string): Promise<boolean> {
	if (autoBootstrapMode === "off" || !looksLikeProjectDirectory(ctx.cwd)) return false;
	if (!ctx.hasUI) return false;
	const slug = path.basename(ctx.cwd).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
	const message = [
		`No memory pack was found for this project directory:`,
		ctx.cwd,
		"",
		`Create and map a new pack named \"${slug}\" now?`,
		"Choose No if you prefer to run /memctx-pack-generate later.",
	].join("\n");
	const confirmed = autoBootstrapMode === "on" ? await ctx.ui.confirm("Create memory pack?", message) : await ctx.ui.confirm("Create memory pack?", message);
	if (!confirmed) {
		ctx.ui.notify("memctx: Pack bootstrap skipped. Run /memctx-pack-generate when you want to create one.", "info");
		return false;
	}
	fs.mkdirSync(packsDir, { recursive: true });
	const { packPath, filesCreated } = generatePackFromDirectory(ctx.cwd, slug, packsDir);
	activePack = slug;
	activePackPath = packPath;
	qmdCollection = `memctx-${slug}`;
	ctx.ui.notify(`memctx: Created pack \"${slug}\" with ${filesCreated.length} files.`, "info");
	return true;
}

// ---------------------------------------------------------------------------
// Test hooks (override state for testing)
// ---------------------------------------------------------------------------

let _packsDir = "";

export function _setVaultRoot(root: string) {
	vaultRoot = root;
}
export function _setActivePack(pack: string, packPath: string) {
	activePack = pack;
	activePackPath = packPath;
	qmdCollection = `memctx-${pack}`;
}
export function _setQmdAvailable(available: boolean) {
	qmdAvailable = available;
	qmdBin = available ? (qmdBin || "qmd") : "";
	qmdStatus = available ? { available: true, bin: qmdBin, source: "path" } : { available: false, source: "missing" };
}
export function _setStrictMode(enabled: boolean) {
	strictMode = enabled;
}
export function _setContextPipelineForTest(pipeline: ContextPipeline) {
	contextPipeline = pipeline;
}
export function _resetState() {
	vaultRoot = "";
	activePack = "";
	activePackPath = "";
	qmdAvailable = false;
	qmdBin = "";
	qmdStatus = { available: false, source: "missing" };
	qmdCollection = "";
	applyMemctxConfig(profileDefaults("gateway"));
	lastRetrieval = null;
	lastGatewayDecision = null;
	lastPackSelection = null;
	lastPackSwitch = null;
	llmStats = { mode: llmMode, callsThisSession: 0, estimatedInputChars: 0, estimatedOutputChars: 0 };
	_packsDir = "";
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// --- session_start: detect vault, active pack, qmd ---
	pi.on("session_start", async (_event, ctx) => {
		applyMemctxConfig(readMemctxConfig());
		let packsDir = resolvePacksDir(ctx.cwd);

		if (!packsDir) {
			const bootstrapped = await maybeBootstrapPack(ctx, DEFAULT_GLOBAL_PACKS_DIR);
			if (bootstrapped) {
				packsDir = DEFAULT_GLOBAL_PACKS_DIR;
			} else {
				if (ctx.hasUI) {
					ctx.ui.notify(
						"memctx: No packs found. Run /memctx-pack-generate to create one, or set MEMCTX_PACKS_PATH.",
						"info",
					);
				}
				return;
			}
		}

		vaultRoot = path.dirname(packsDir);
		_packsDir = packsDir;
		const detected = detectActivePack(packsDir, ["cwd", "all"].includes(autoSwitchMode) ? ctx.cwd : undefined);

		if (!detected) {
			if (ctx.hasUI) {
				ctx.ui.notify("memctx: No memory packs found. Run `npm run new-pack` to create one.", "info");
			}
			return;
		}

		activePack = detected;
		activePackPath = path.join(packsDir, detected);
		qmdCollection = `memctx-${detected}`;

		// Detect qmd
		qmdAvailable = await detectQmd();

		if (qmdAvailable) {
			// Index pack in background (fire-and-forget)
			qmdEmbed(qmdCollection, activePackPath).catch(() => {});
		}

		if (ctx.hasUI) {
			const qmdLabel = qmdAvailable
				? `qmd ✓ (${qmdStatus.source})`
				: "qmd ✗ (grep fallback)";
			const selection = lastPackSelection?.pack === activePack ? ` ${lastPackSelection.confidence} cwd match` : "";
			ctx.ui.notify(`memctx: Pack "${activePack}" loaded.${selection} ${qmdLabel} profile:${currentProfile}`, "info");
			if (startupDoctorMode !== "off") {
				const queueCount = readSaveQueue().length;
				const warnings = [
					!qmdAvailable ? "qmd unavailable; using grep fallback" : "",
					queueCount > 0 ? `${queueCount} memory candidate${queueCount === 1 ? "" : "s"} pending review` : "",
				].filter(Boolean);
				if (warnings.length > 0) ctx.ui.notify(`memctx doctor: ${warnings.join("; ")}`, "warning");
			}
			ctx.ui.setStatus("memctx", buildStatusText());
		}
	});

	// --- before_agent_start: inject pack context ---
	pi.on("before_agent_start", async (event, ctx) => {
		if (!activePackPath) return;
		const packsDir = _packsDir || (vaultRoot ? path.join(vaultRoot, "packs") : "");
		if (packsDir && event.prompt) {
			await maybeSwitchPackByPrompt(event.prompt, packsDir, ctx);
		}

		let searchResults = "";
		let retrievalMode: RetrievalStatus["mode"] = "none";
		let resultCount = 0;
		let retrievalQuery = "";
		let retrievalQueries: string[] = [];
		let crossPackHits: string[] = [];
		let retrievalDurationMs = 0;
		let retrievalBudgetMs = retrievalLatencyBudgetMs;
		let retrievalTimedOut = false;

		if (event.prompt?.trim()) {
			const retrieval = await retrieveForPrompt(event.prompt, ctx);
			searchResults = retrieval.text;
			retrievalMode = retrieval.mode;
			resultCount = retrieval.count;
			retrievalQuery = retrieval.query;
			retrievalQueries = retrieval.queries;
			crossPackHits = retrieval.crossPackHits;
			retrievalDurationMs = retrieval.durationMs;
			retrievalBudgetMs = retrieval.budgetMs;
			retrievalTimedOut = retrieval.timedOut;
		}

		const packContext = ["gateway", "qmd-economy"].includes(contextPipeline)
			? await buildMemoryGatewayContext(activePackPath, event.prompt ?? "", searchResults, retrievalMode, ctx)
			: buildPackContext(activePackPath, searchResults, event.prompt ?? "");
		if (!packContext) return;

		lastRetrieval = {
			prompt: truncate(event.prompt ?? "", 200),
			mode: retrievalMode,
			query: retrievalQuery,
			queries: retrievalQueries,
			policy: retrievalPolicy,
			resultCount,
			crossPackHits,
			durationMs: retrievalDurationMs,
			budgetMs: retrievalBudgetMs,
			timedOut: retrievalTimedOut,
			contextChars: packContext.length,
			contextEstimatedTokens: estimateTokens(packContext),
			contextBudgetTokens: contextTokenBudget,
			contextMode,
			timestamp: nowTimestamp(),
		};

		const memoryGate = ["gateway", "qmd-economy"].includes(contextPipeline)
			? ""
			: [
				"## Memory Gate",
				"For project-specific questions:",
				"1. Use the loaded memory context first.",
				"2. Prefer the loaded compact memory; call memctx_search only when the loaded context is missing, ambiguous, or likely stale.",
				"3. Inspect source-of-truth files only when memory is insufficient, conflicts with files, or the user asks for current file state.",
				"4. If you discover durable safe knowledge, save or suggest saving it with memctx_save.",
				"5. Never save secrets, credentials, private keys, tokens, customer data, or sensitive payloads.",
				strictMode
					? "6. Strict mode is ON: before final answers for project-specific prompts, call memctx_search unless the answer is fully supported by injected memory context."
					: "",
			].filter(Boolean).join("\n");

		const injection = ["gateway", "qmd-economy"].includes(contextPipeline)
			? [
				"\n\n## pi-memctx Memory Gateway",
				packContext,
			].join("\n")
			: [
				"\n\n## Memory Context",
				`Active pack: \`${activePack}\``,
				`Retrieval: ${retrievalMode} (${resultCount} result${resultCount === 1 ? "" : "s"}; policy: ${retrievalPolicy})`,
				`Context budget: ${contextPipeline}/${contextMode}, ~${estimateTokens(packContext)}/${contextTokenBudget} tokens, ${contextMaxItems} max items`,
				retrievalQueries.length ? `Queries attempted: ${retrievalQueries.map((q) => `\`${q}\``).join(", ")}` : "Queries attempted: none",
				crossPackHits.length ? `Cross-pack hints: ${crossPackHits.join(", ")}` : "",
				"The following memory context has been loaded from the pack.",
				"Use memctx_search only when the compact context is insufficient; avoid redundant source exploration when memory already answers the prompt.",
				"",
				memoryGate,
				"",
				packContext,
			].join("\n");

		if (ctx.hasUI) ctx.ui.setStatus("memctx", buildStatusText());

		return {
			systemPrompt: event.systemPrompt + injection,
		};
	});

	// --- session_before_compact: capture session handoff ---
	pi.on("session_before_compact", async (_event, ctx) => {
		if (!activePackPath || !activePack) return;

		const sessionId = ctx.sessionManager.getSessionId();
		const branch = ctx.sessionManager.getBranch();

		// Build summary from recent messages
		const recentMessages: string[] = [];
		const recent = branch.slice(-10);
		for (const entry of recent) {
			if (entry.type === "message") {
				const msg = (entry as any).message;
				if (msg?.role === "user" && typeof msg.content === "string") {
					recentMessages.push(`User: ${msg.content.slice(0, 200)}`);
				} else if (msg?.role === "assistant") {
					const content = msg.content;
					if (typeof content === "string") {
						recentMessages.push(`Assistant: ${content.slice(0, 200)}`);
					} else if (Array.isArray(content)) {
						for (const block of content) {
							if (block.type === "text") {
								recentMessages.push(`Assistant: ${block.text.slice(0, 200)}`);
								break;
							}
						}
					}
				}
			}
		}

		if (recentMessages.length === 0) return;

		let summary = recentMessages.join("\n");
		if (llmMode !== "off" && ctx.model) {
			const digest = await completeJsonWithLlm<{ summary?: string; completedActions?: string[]; decisions?: string[]; openQuestions?: string[]; memoryCandidates?: string[] }>(ctx, "session-handoff-digest", [
				"Create a compact structured session handoff from recent conversation messages.",
				"Return ONLY JSON with summary, completedActions[], decisions[], openQuestions[], memoryCandidates[]. Do not include secrets.",
			].join("\n"), { messages: recentMessages });
			if (digest?.summary) {
				summary = [
					`## Summary\n\n${digest.summary}`,
					digest.completedActions?.length ? `## Completed actions\n\n${digest.completedActions.map((x) => `- ${x}`).join("\n")}` : "",
					digest.decisions?.length ? `## Decisions\n\n${digest.decisions.map((x) => `- ${x}`).join("\n")}` : "",
					digest.openQuestions?.length ? `## Open questions\n\n${digest.openQuestions.map((x) => `- ${x}`).join("\n")}` : "",
					digest.memoryCandidates?.length ? `## Memory candidates\n\n${digest.memoryCandidates.map((x) => `- ${x}`).join("\n")}` : "",
				].filter(Boolean).join("\n\n");
			}
		}
		const handoff = buildSessionHandoff(sessionId, activePack, summary);

		const today = todayStr();
		const shortId = sessionId.slice(0, 8);
		const actionsDir = path.join(activePackPath, "40-actions");
		fs.mkdirSync(actionsDir, { recursive: true });
		const handoffPath = path.join(actionsDir, `${today}-session-handoff-${shortId}.md`);
		fs.writeFileSync(handoffPath, handoff, "utf-8");

		// Re-index after writing
		if (qmdAvailable) {
			qmdEmbed(qmdCollection, activePackPath).catch(() => {});
		}
	});

	// --- session_shutdown: cleanup ---
	pi.on("session_shutdown", async (_event, _ctx) => {
		// Nothing to flush at the moment
	});

	// --- /memctx-pack-status command: show active pack and retrieval state ---
	const packStatusCommand = {
		description: "Show active memory pack, qmd, retrieval, strict-mode, and LLM status. Usage: /memctx-pack-status",
		handler: async (_args: string, ctx: ExtensionContext) => {
			const packsDir = _packsDir || (vaultRoot ? path.join(vaultRoot, "packs") : "");
			const packFileCount = activePackPath ? scanPackFiles(activePackPath).length : 0;
			const gatewayStatus = lastGatewayDecision
				? [
					`Gateway: ${lastGatewayDecision.status} (${Math.round(lastGatewayDecision.confidence * 100)}%, ${lastGatewayDecision.backend})`,
					`  candidates: ${lastGatewayDecision.candidateCount}, injected: ${lastGatewayDecision.injected ? "yes" : "no"}`,
					`  reason: ${lastGatewayDecision.reason || "<none>"}`,
					`  at: ${lastGatewayDecision.timestamp}`,
				]
				: [`Gateway: ${["gateway", "qmd-economy"].includes(contextPipeline) ? "pending" : "off"}`];
			const retrieval = lastRetrieval
				? [
					`Last retrieval: ${lastRetrieval.mode}`,
					`  policy: ${lastRetrieval.policy}`,
					`  query: ${lastRetrieval.query || "<none>"}`,
					`  queries: ${lastRetrieval.queries.join(" | ") || "<none>"}`,
					`  results: ${lastRetrieval.resultCount}`,
					`  duration: ${lastRetrieval.durationMs}ms / ${lastRetrieval.budgetMs}ms${lastRetrieval.timedOut ? " (budget reached)" : ""}`,
					`  context: ${lastRetrieval.contextMode ?? contextMode}, ~${lastRetrieval.contextEstimatedTokens ?? 0}/${lastRetrieval.contextBudgetTokens ?? contextTokenBudget} tokens (${lastRetrieval.contextChars ?? 0} chars)`,
					`  cross-pack hits: ${lastRetrieval.crossPackHits.join(", ") || "<none>"}`,
					`  at: ${lastRetrieval.timestamp}`,
				]
				: ["Last retrieval: none"];
			const selection = lastPackSelection
				? [
					`Selection: ${lastPackSelection.confidence} (${lastPackSelection.score})`,
					`  reasons: ${lastPackSelection.reasons.join("; ") || "<none>"}`,
				]
				: ["Selection: <none>"];
			const switchLines = lastPackSwitch
				? [`Last switch: ${lastPackSwitch.from || "<none>"} → ${lastPackSwitch.to}`, `  reason: ${lastPackSwitch.reason}`, `  at: ${lastPackSwitch.timestamp}`]
				: ["Last switch: none"];
			const lines = [
				`Profile: ${currentProfile}${currentProfile === "custom" ? ` (base ${baseProfile})` : ""}`,
				`Config path: ${memctxConfigPath()}`,
				`Active pack: ${activePack || "<none>"}`,
				`Pack path: ${activePackPath || "<none>"}`,
				`Packs dir: ${packsDir || "<none>"}`,
				`Pack files: ${packFileCount} markdown files`,
				`Auto-switch: ${autoSwitchMode}`,
				`Retrieval policy: ${retrievalPolicy}`,
				`Retrieval budget: ${retrievalLatencyBudgetMs}ms`,
				`Gateway judge: ${gatewayJudgeMode}`,
				`Context: ${contextPipeline}/${contextMode}, budget ~${contextTokenBudget} tokens, max items ${contextMaxItems}, strip metadata ${contextStripMetadata ? "on" : "off"}`,
				`Autosave: ${autosaveMode}`,
				`Autosave low-confidence queue: ${autosaveQueueLowConfidence ? "on" : "off"}`,
				`Save queue: ${readSaveQueue().length} pending`,
				...selection,
				...switchLines,
				`qmd: ${qmdStatus.available ? "available" : "unavailable"}`,
				`qmd source: ${qmdStatus.source}`,
				`qmd bin: ${qmdStatus.bin ?? "<none>"}`,
				`qmd version: ${qmdStatus.version ?? "<unknown>"}`,
				`qmd error: ${qmdStatus.error ?? "<none>"}`,
				`qmd collection: ${qmdCollection || "<none>"}`,
				`Strict mode: ${strictMode ? "on" : "off"}`,
				`LLM mode: ${llmMode}`,
				`LLM calls: ${llmStats.callsThisSession}`,
				`LLM last use: ${llmStats.lastUseCase ?? "<none>"}`,
				`LLM last decision: ${llmStats.lastDecision ?? "<none>"}`,
				`LLM chars: in ${llmStats.estimatedInputChars}, out ${llmStats.estimatedOutputChars}`,
				`LLM error: ${llmStats.lastError ?? "<none>"}`,
				...gatewayStatus,
				...retrieval,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	};
	pi.registerCommand("memctx-pack-status", packStatusCommand);
	pi.registerCommand("pack-status", {
		...packStatusCommand,
		description: "Deprecated alias for /memctx-pack-status.",
	});

	// --- /memctx-profile command: apply zero-config behavior profiles ---
	pi.registerCommand("memctx-profile", {
		description: "Apply the memory gateway profile. Usage: /memctx-profile [gateway|status]",
		handler: async (args, ctx) => {
			const target = (args ?? "status").trim().toLowerCase();
			if (["gateway", "gateway-lite", "gateway-full"].includes(target)) {
				const config = profileDefaults("gateway");
				applyMemctxConfig(config);
				writeMemctxConfig(config);
			} else if (target && target !== "status") {
				ctx.ui.notify("memctx: Usage: /memctx-profile [gateway|status]", "error");
				return;
			}
			ctx.ui.notify([
				`memctx profile: ${currentProfile}`,
				`strict: ${strictMode ? "on" : "off"}`,
				`retrieval: ${retrievalPolicy} (${retrievalLatencyBudgetMs}ms)`,
				`autosave: ${autosaveMode}`,
				`llm: ${llmMode}`,
				`auto-switch: ${autoSwitchMode}`,
				`gateway judge: ${gatewayJudgeMode}`,
				`auto-bootstrap: ${autoBootstrapMode}`,
			].join("\n"), "info");
			ctx.ui.setStatus("memctx", buildStatusText());
		},
	});

	// --- /memctx-config command: inspect/reset persistent config ---
	pi.registerCommand("memctx-config", {
		description: "Show or reset persistent memctx config. Usage: /memctx-config [status|reset]",
		handler: async (args, ctx) => {
			const target = (args ?? "status").trim().toLowerCase();
			if (target === "reset") {
				const config = profileDefaults("gateway");
				applyMemctxConfig(config);
				writeMemctxConfig(config);
				ctx.ui.notify("memctx: Config reset to profile:gateway.", "info");
				ctx.ui.setStatus("memctx", buildStatusText());
				return;
			}
			if (target && target !== "status") {
				ctx.ui.notify("memctx: Usage: /memctx-config [status|reset]", "error");
				return;
			}
			ctx.ui.notify(`memctx config: ${memctxConfigPath()}\n${JSON.stringify(currentMemctxConfig(), null, 2)}`, "info");
		},
	});

	// --- /memctx-strict command: toggle strict memory gate ---
	pi.registerCommand("memctx-strict", {
		description: "Toggle strict memory retrieval guidance. Usage: /memctx-strict [on|off|status]",
		handler: async (args, ctx) => {
			const target = (args ?? "status").trim().toLowerCase();
			let changed = false;
			if (["on", "true", "1", "yes"].includes(target)) {
				strictMode = true;
				changed = true;
			} else if (["off", "false", "0", "no"].includes(target)) {
				strictMode = false;
				changed = true;
			} else if (target && target !== "status") {
				ctx.ui.notify("memctx: Usage: /memctx-strict [on|off|status]", "error");
				return;
			}
			if (changed) markCustomAndPersist();
			ctx.ui.notify(`memctx: Strict mode ${strictMode ? "on" : "off"}.`, "info");
			ctx.ui.setStatus("memctx", buildStatusText());
		},
	});

	// --- /memctx-auto-switch command: toggle cwd/prompt pack switching ---
	pi.registerCommand("memctx-auto-switch", {
		description: "Configure automatic pack switching. Usage: /memctx-auto-switch [off|cwd|prompt|all|status]",
		handler: async (args, ctx) => {
			const target = (args ?? "status").trim().toLowerCase();
			let changed = false;
			if (["off", "cwd", "prompt", "all"].includes(target)) {
				autoSwitchMode = target as AutoSwitchMode;
				changed = true;
			} else if (target && target !== "status") {
				ctx.ui.notify("memctx: Usage: /memctx-auto-switch [off|cwd|prompt|all|status]", "error");
				return;
			}
			if (changed) markCustomAndPersist();
			ctx.ui.notify(`memctx: Auto-switch ${autoSwitchMode}.`, "info");
			ctx.ui.setStatus("memctx", buildStatusText());
		},
	});

	// --- /memctx-llm command: configure LLM assistance ---
	pi.registerCommand("memctx-llm", {
		description: "Configure LLM assistance. Usage: /memctx-llm [off|assist|first|status]",
		handler: async (args, ctx) => {
			const target = (args ?? "status").trim().toLowerCase();
			let changed = false;
			if (["off", "assist", "first"].includes(target)) {
				llmMode = target as LlmMode;
				llmStats.mode = llmMode;
				changed = true;
			} else if (target && target !== "status") {
				ctx.ui.notify("memctx: Usage: /memctx-llm [off|assist|first|status]", "error");
				return;
			}
			if (changed) markCustomAndPersist();
			ctx.ui.notify(`memctx: LLM mode ${llmMode}. Calls this session: ${llmStats.callsThisSession}. Last: ${llmStats.lastUseCase ?? "none"}.`, "info");
			ctx.ui.setStatus("memctx", buildStatusText());
		},
	});

	// --- /memctx-retrieval command: configure automatic retrieval depth ---
	pi.registerCommand("memctx-retrieval", {
		description: "Configure automatic memory retrieval. Usage: /memctx-retrieval [auto|fast|balanced|deep|strict|status]",
		handler: async (args, ctx) => {
			const target = (args ?? "status").trim().toLowerCase();
			let changed = false;
			if (["auto", "fast", "balanced", "deep", "strict"].includes(target)) {
				retrievalPolicy = target as RetrievalPolicy;
				changed = true;
			} else if (target && target !== "status") {
				ctx.ui.notify("memctx: Usage: /memctx-retrieval [auto|fast|balanced|deep|strict|status]", "error");
				return;
			}
			if (changed) markCustomAndPersist();
			ctx.ui.notify(`memctx: Retrieval policy ${retrievalPolicy}.`, "info");
			ctx.ui.setStatus("memctx", buildStatusText());
		},
	});

	// --- /memctx-autosave command: configure memory capture behavior ---
	pi.registerCommand("memctx-autosave", {
		description: "Configure memory save suggestions. Usage: /memctx-autosave [off|suggest|confirm|auto|status]",
		handler: async (args, ctx) => {
			const target = (args ?? "status").trim().toLowerCase();
			let changed = false;
			if (["off", "suggest", "confirm", "auto"].includes(target)) {
				autosaveMode = target as AutosaveMode;
				changed = true;
			} else if (target && target !== "status") {
				ctx.ui.notify("memctx: Usage: /memctx-autosave [off|suggest|confirm|auto|status]", "error");
				return;
			}
			if (changed) markCustomAndPersist();
			ctx.ui.notify(`memctx: Autosave ${autosaveMode}. Save queue: ${readSaveQueue().length} pending.`, "info");
			ctx.ui.setStatus("memctx", buildStatusText());
		},
	});

	// --- /memctx-save-queue command: review pending memory candidates ---
	pi.registerCommand("memctx-save-queue", {
		description: "Review memory save candidates. Usage: /memctx-save-queue [list|approve <id>|reject <id>|clear]",
		handler: async (args, ctx) => {
			const [action = "list", id = ""] = (args ?? "").trim().split(/\s+/).filter(Boolean);
			let queue = readSaveQueue();
			if (action === "clear") {
				writeSaveQueue([]);
				ctx.ui.notify("memctx: Save queue cleared.", "info");
				return;
			}
			if (action === "reject") {
				queue = queue.filter((item) => item.id !== id);
				writeSaveQueue(queue);
				ctx.ui.notify(`memctx: Rejected candidate ${id || "<none>"}.`, "info");
				return;
			}
			if (action === "approve") {
				const candidate = queue.find((item) => item.id === id);
				if (!candidate) {
					ctx.ui.notify(`memctx: Candidate not found: ${id}`, "error");
					return;
				}
				try {
					const saved = saveMemoryCandidate(candidate);
					writeSaveQueue(queue.filter((item) => item.id !== id));
					if (qmdAvailable) qmdEmbed(qmdCollection, activePackPath).catch(() => {});
					ctx.ui.notify(`memctx: Saved candidate to ${saved.rel}`, "info");
				} catch (err) {
					ctx.ui.notify(`memctx: Could not save candidate: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
				return;
			}
			if (queue.length === 0) {
				ctx.ui.notify("memctx: Save queue is empty.", "info");
				return;
			}
			ctx.ui.notify(queue.map((item) => `${item.id}: ${item.type} · ${item.title} · ${Math.round(item.confidence * 100)}%`).join("\n"), "info");
		},
	});

	// --- /memctx-doctor command: diagnose runtime and pack health ---
	pi.registerCommand("memctx-doctor", {
		description: "Diagnose active memory pack health and runtime configuration. Usage: /memctx-doctor",
		handler: async (_args, ctx) => {
			const files = activePackPath ? scanPackFiles(activePackPath) : [];
			const placeholders = files.filter((file) => readFileSafe(file)?.includes("<Add wikilink>")).length;
			const possibleSecrets = files.filter((file) => sensitivePatternHit(path.basename(file), readFileSafe(file) ?? "")).length;
			const duplicateSlugs = new Set<string>();
			const seen = new Set<string>();
			for (const file of files) {
				const slug = path.basename(file).replace(/^\d{4}-\d{2}-\d{2}-/, "");
				if (seen.has(slug)) duplicateSlugs.add(slug);
				seen.add(slug);
			}
			const lines = [
				`Pack: ${activePack || "<none>"}`,
				`Path: ${activePackPath || "<none>"}`,
				`Files: ${files.length} markdown`,
				`qmd: ${qmdStatus.available ? "available" : "unavailable"} (${qmdStatus.source})`,
				`qmd collection: ${qmdCollection || "<none>"}`,
				`Retrieval: ${retrievalPolicy}`,
				`Autosave: ${autosaveMode}`,
				`LLM: ${llmMode}`,
				`Strict: ${strictMode ? "on" : "off"}`,
				`Save queue: ${readSaveQueue().length} pending`,
				`Template placeholders: ${placeholders}`,
				`Possible duplicate slugs: ${duplicateSlugs.size}`,
				`Secret scan warnings: ${possibleSecrets}`,
			];
			ctx.ui.notify(lines.join("\n"), possibleSecrets ? "warning" : "info");
		},
	});

	// --- /memctx-pack-enrich command: enrich existing pack with LLM/qmd notes ---
	pi.registerCommand("memctx-pack-enrich", {
		description: "Run qmd/LLM-assisted enrichment for the active pack in the background. Usage: /memctx-pack-enrich [source-dir]",
		handler: async (args, ctx) => {
			if (!activePackPath || !activePack) {
				ctx.ui.notify("memctx: No active pack to enrich.", "error");
				return;
			}
			if (packEnrichRunning) {
				ctx.ui.notify("memctx enrich: already running in the background. Wait for completion before starting another enrich.", "warning");
				return;
			}
			let scanDir = (args ?? "").trim();
			if (!scanDir) {
				const resource = readFileSafe(path.join(activePackPath, "00-system", "pi-agent", "resource-map.md")) ?? "";
				scanDir = resource.match(/## Source directory\s*\n\s*`([^`]+)`/m)?.[1] ?? "";
			}
			if (!scanDir || !fs.existsSync(scanDir)) {
				ctx.ui.notify("memctx: Source directory not found. Usage: /memctx-pack-enrich [source-dir]", "error");
				return;
			}
			const pack = activePack;
			const packPath = activePackPath;
			const collection = qmdCollection;
			const started = Date.now();
			packEnrichRunning = true;
			ctx.ui.notify(`memctx enrich: started in background for pack ${pack}\nsource: ${scanDir}\nqmd: ${qmdAvailable ? "available" : "unavailable"}\nllm: ${llmMode}${llmMode === "off" || !ctx.model ? " (architecture synthesis skipped; fact cards still run)" : ""}`, "info");
			ctx.ui.setStatus("memctx", `📦 ${pack} · enriching in background`);
			void (async () => {
				try {
					const files = await enrichGeneratedPackWithLlm(scanDir, pack, packPath, ctx);
					if (qmdAvailable && collection) qmdEmbed(collection, packPath).catch(() => {});
					ctx.ui.notify(`memctx enrich: complete in ${Date.now() - started}ms\nupdated files: ${files.length}\n${files.map((f) => `- ${path.relative(packPath, f)}`).slice(0, 12).join("\n")}${files.length > 12 ? "\n- ..." : ""}`, "info");
				} catch (err) {
					ctx.ui.notify(`memctx enrich: failed after ${Date.now() - started}ms: ${err instanceof Error ? err.message : String(err)}`, "error");
				} finally {
					packEnrichRunning = false;
					ctx.ui.setStatus("memctx", buildStatusText());
				}
			})();
		},
	});

	// --- /memctx-pack command: list and switch packs ---
	const packCommand = {
		description: "List or switch memory packs. Usage: /memctx-pack [name]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const packsDir = _packsDir || resolvePacksDir(ctx.cwd);
			if (!packsDir) {
				ctx.ui.notify("memctx: No packs found. Use /memctx-pack-generate to create one.", "error");
				return;
			}

			const packs = listPacks(packsDir);

			if (packs.length === 0) {
				ctx.ui.notify("memctx: No packs found.", "info");
				return;
			}

			const target = args?.trim();

			if (!target) {
				// No argument: show picker
				const options = packs.map((p) =>
					p === activePack ? `📦 ${p} (active)` : p,
				);

				const selected = await ctx.ui.select("Select memory pack", options);
				if (!selected) return;

				// Strip the prefix if it was the active one
				const packName = selected.replace(/^📦 /, "").replace(/ \(active\)$/, "");

				if (packName === activePack) {
					ctx.ui.notify(`memctx: Already using pack "${activePack}".`, "info");
					return;
				}

				const from = activePack;
				activePack = packName;
				activePackPath = path.join(packsDir, packName);
				qmdCollection = `memctx-${packName}`;
				lastPackSwitch = { from, to: packName, reason: "manual /memctx-pack selection", confidence: "high", timestamp: nowTimestamp() };

				if (qmdAvailable) {
					qmdEmbed(qmdCollection, activePackPath).catch(() => {});
				}

				ctx.ui.notify(`memctx: Switched to pack "${activePack}".`, "info");
				ctx.ui.setStatus("memctx", buildStatusText());
				return;
			}

			// Argument provided: switch directly
			if (!packs.includes(target)) {
				ctx.ui.notify(`memctx: Pack "${target}" not found. Available: ${packs.join(", ")}`, "error");
				return;
			}

			if (target === activePack) {
				ctx.ui.notify(`memctx: Already using pack "${activePack}".`, "info");
				return;
			}

			const from = activePack;
			activePack = target;
			activePackPath = path.join(packsDir, target);
			qmdCollection = `memctx-${target}`;
			lastPackSwitch = { from, to: target, reason: "manual /memctx-pack argument", confidence: "high", timestamp: nowTimestamp() };

			if (qmdAvailable) {
				qmdEmbed(qmdCollection, activePackPath).catch(() => {});
			}

			ctx.ui.notify(`memctx: Switched to pack "${activePack}".`, "info");
			ctx.ui.setStatus("memctx", buildStatusText());
		},
	};
	pi.registerCommand("memctx-pack", packCommand);
	pi.registerCommand("pack", {
		...packCommand,
		description: "Deprecated alias for /memctx-pack.",
	});

	// --- /memctx-pack-generate command: generate a pack from a directory ---
	const packGenerateCommand = {
		description: "Generate a memory pack from a directory of repos. Usage: /memctx-pack-generate [path] [slug]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			// Resolve packs directory — create default if none exists
			let packsDir = _packsDir;
			if (!packsDir) {
				// Try to find existing packs dir
				const resolvedPacksDir = resolvePacksDir(ctx.cwd);
				if (resolvedPacksDir) packsDir = resolvedPacksDir;
			}
			if (!packsDir) {
				// Create default global packs directory
				packsDir = DEFAULT_GLOBAL_PACKS_DIR;
				fs.mkdirSync(packsDir, { recursive: true });
			}

			const parts = (args ?? "").trim().split(/\s+/);
			let scanDir = parts[0] || ctx.cwd;
			let slug = parts[1] || "";

			// Resolve relative paths
			if (!path.isAbsolute(scanDir)) {
				scanDir = path.resolve(ctx.cwd, scanDir);
			}

			if (!fs.existsSync(scanDir)) {
				ctx.ui.notify(`memctx: Directory not found: ${scanDir}`, "error");
				return;
			}

			// Derive slug from directory name if not provided
			if (!slug) {
				slug = path.basename(scanDir).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
			}

			const targetPackPath = path.join(packsDir, slug);
			if (fs.existsSync(targetPackPath)) {
				const overwrite = await ctx.ui.confirm(
					"Pack exists",
					`Pack "${slug}" already exists at ${targetPackPath}. Overwrite?`,
				);
				if (!overwrite) return;
				fs.rmSync(targetPackPath, { recursive: true });
			}

			ctx.ui.notify(`memctx: Scanning ${scanDir}...`, "info");

			const { packPath, filesCreated } = generatePackFromDirectory(scanDir, slug, packsDir);
			if (llmMode !== "off" && ctx.model) {
				ctx.ui.notify(`memctx: Running LLM-assisted deep pack enrichment for "${slug}"...`, "info");
				const enriched = await enrichGeneratedPackWithLlm(scanDir, slug, packPath, ctx);
				filesCreated.push(...enriched);
			} else if (llmMode !== "off" && !ctx.model) {
				ctx.ui.notify("memctx: LLM enrichment skipped because no model is selected.", "warning");
			}

			// Index with qmd if available
			if (qmdAvailable) {
				const collection = `memctx-${slug}`;
				await qmdEmbed(collection, packPath);
			}

			ctx.ui.notify(
				`memctx: Pack "${slug}" generated with ${filesCreated.length} files from ${scanDir}`,
				"info",
			);

			// Auto-switch to the new pack
			_packsDir = packsDir;
			vaultRoot = path.dirname(packsDir);
			activePack = slug;
			activePackPath = packPath;
			qmdCollection = `memctx-${slug}`;
			lastPackSwitch = { from: "", to: slug, reason: "generated new pack", confidence: "high", timestamp: nowTimestamp() };
			ctx.ui.setStatus("memctx", buildStatusText());
		},
	};
	pi.registerCommand("memctx-pack-generate", packGenerateCommand);
	pi.registerCommand("pack-generate", {
		...packGenerateCommand,
		description: "Deprecated alias for /memctx-pack-generate.",
	});

	// --- memctx_search tool ---
	pi.registerTool({
		name: "memctx_search",
		label: "Memory Search",
		description: [
			"Search across memory context pack files for relevant context. Do not use when the injected Memory Gateway Brief says Status: sufficient; in that case answer from the brief.",
			"Modes:",
			"- 'keyword' (default, fast): BM25 text search. Best for specific terms, tags, note names.",
			"- 'semantic' (~2s): Meaning-based search. Finds related concepts with different wording.",
			"- 'deep' (~10s): Hybrid with reranking. Use when other modes miss results.",
			"If qmd is not installed, falls back to grep-based keyword search across Markdown files.",
		].join("\n"),
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			mode: Type.Optional(
				StringEnum(["keyword", "semantic", "deep"] as const, {
					description: "Search mode. Default: 'keyword'.",
				}),
			),
			limit: Type.Optional(Type.Number({ description: "Max results (default: 5)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const sameAsInjectedPrompt = lastRetrieval?.prompt && normalizeSearchText(params.query).includes(normalizeSearchText(lastRetrieval.prompt));
			if (sameAsInjectedPrompt && baseProfile === "gateway" && contextPipeline === "gateway" && lastGatewayDecision?.status === "sufficient" && lastGatewayDecision.injected) {
				return {
					content: [{
						type: "text" as const,
						text: "Memory Gateway already injected sufficient memory for the current prompt. Do not search again; answer from the Memory Gateway Brief unless the user explicitly asks for different/additional memory.",
					}],
					details: { skipped: true, reason: "gateway-sufficient", status: lastGatewayDecision.status },
				};
			}

			if (!activePackPath) {
				return {
					content: [{ type: "text" as const, text: "No active memory pack. Install a pack under packs/ first." }],
					details: {},
				};
			}

			const { query, mode = "keyword", limit = 5 } = params;
			const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
			const search = await searchPackMemory(activePackPath, query, limit, mode as SearchMode);

			if (search.matchCount === 0) {
				// Try cross-pack search to suggest the right pack
				const packsDir = _packsDir || path.join(vaultRoot, "packs");
				const allPacks = listPacks(packsDir);
				const crossResults: string[] = [];

				for (const p of allPacks) {
					if (p === activePack) continue;
					const pPath = path.join(packsDir, p);
					const pFiles = scanPackFiles(pPath);
					for (const f of pFiles) {
						const content = readFileSafe(f);
						if (!content) continue;
						const contentLower = content.toLowerCase();
						const score = terms.filter((t) => contentLower.includes(t)).length;
						if (score > 0 && !crossResults.includes(p)) {
							crossResults.push(p);
						}
					}
				}

				const hint = crossResults.length > 0
					? "\n\nTry switching pack: " + crossResults.map((p) => "/memctx-pack " + p).join(", ")
					: "";

				return {
					content: [{
						type: "text" as const,
						text: `No results for "${query}" in pack "${activePack}".${hint}`,
					}],
					details: { mode: search.mode, crossPackHints: crossResults },
				};
			}

			const header = search.mode === "qmd"
				? `## Search results (qmd ${mode})`
				: "## Search results (grep fallback)";
			return {
				content: [
					{
						type: "text" as const,
						text: `${header}\n\n${search.text}`,
					},
				],
				details: { mode: search.mode, matchCount: search.matchCount, collection: qmdCollection },
			};
		},
	});

	// --- memctx_save tool: persist learnings to the pack ---
	pi.registerTool({
		name: "memctx_save",
		label: "Memory Save",
		description: [
			"Save a note to the active memory context pack.",
			"Use this when you discover durable knowledge that should be remembered across sessions:",
			"- observation: something discovered about code, infra, behavior, conventions",
			"- decision: a technical or architectural decision with rationale",
			"- action: something that was done (deploy, migration, config change)",
			"- runbook: a repeatable procedure (deploy steps, troubleshooting)",
			"- context: project context, stack info, team conventions",
			"",
			"DO save: conventions, patterns, safe commands, architecture decisions, deploy procedures, environment details.",
			"DO NOT save: secrets, tokens, passwords, API keys, sensitive customer data, transient info.",
			"",
			"The note is saved as Markdown with pack-compliant frontmatter and Obsidian wikilinks.",
		].join("\n"),
		parameters: Type.Object({
			type: StringEnum(["observation", "decision", "action", "runbook", "context"] as const, {
				description: "Note type. observation=discovered fact, decision=choice with rationale, action=completed task, runbook=procedure, context=project info.",
			}),
			title: Type.String({ description: "Short descriptive title (e.g., 'Deploy uses tag-driven workflow', 'PostgreSQL RLS for multi-tenancy')" }),
			content: Type.String({ description: "Markdown content of the note. Include context, rationale, commands, links." }),
			tags: Type.Optional(Type.Array(Type.String(), { description: "Additional tags (e.g., 'go', 'ci-cd', 'aws')" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			if (!activePackPath || !activePack) {
				return {
					content: [{ type: "text" as const, text: "No active memory pack. Load a pack first." }],
					details: {},
				};
			}

			const { type: noteType, title, content, tags = [] } = params;

			// Safety check
			const sensitivePatterns = [
				/(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|credential)\s*[:=]/i,
				/(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/,
				/(?:AKIA[0-9A-Z]{16})/,  // AWS access key
				/(?:ghp_[a-zA-Z0-9]{36})/,  // GitHub token
				/(?:sk-[a-zA-Z0-9]{40,})/,  // OpenAI key
			];

			for (const pattern of sensitivePatterns) {
				if (pattern.test(content) || pattern.test(title)) {
					return {
						content: [{
							type: "text" as const,
							text: "\u26d4 Blocked: content appears to contain secrets or credentials. Memory context never stores sensitive data.",
						}],
						details: { blocked: true },
						isError: true,
					};
				}
			}

			const noteDir = resolveNoteDir(activePackPath, noteType as NoteType);
			const today = todayStr();
			const fileSlug = slugify(title);
			const fileName = noteType === "action"
				? `${today}-${fileSlug}.md`
				: `${fileSlug}.md`;
			const filePath = path.join(noteDir, fileName);

			// Check for existing note with same slug
			if (fs.existsSync(filePath)) {
				// Append to existing note
				const existing = readFileSafe(filePath) ?? "";
				const timestamp = nowTimestamp();
				const update = `\n\n---\n\n## Update (${timestamp})\n\n${content}\n`;
				fs.writeFileSync(filePath, existing + update);

				if (qmdAvailable) {
					qmdEmbed(qmdCollection, activePackPath).catch(() => {});
				}

				const rel = path.relative(activePackPath, filePath);
				return {
					content: [{ type: "text" as const, text: `Updated existing note: ${rel}` }],
					details: { path: rel, action: "updated" },
				};
			}

			// Create new note
			const noteContent = buildNote(activePack, noteType as NoteType, title, content, tags);
			fs.writeFileSync(filePath, noteContent);

			// Update index if it exists
			const indexDir = path.join(activePackPath, "00-system", "indexes");
			const indexCandidates = [
				`${noteType}-index.md`,
				"context-index.md",
			];
			for (const indexFile of indexCandidates) {
				const indexPath = path.join(indexDir, indexFile);
				if (fs.existsSync(indexPath)) {
					const indexContent = readFileSafe(indexPath) ?? "";
					const rel = path.relative(activePackPath, filePath).replace(".md", "");
					const wikilink = `| [[packs/${activePack}/${rel}\\|${title}]] | ${noteType} |`;
					if (!indexContent.includes(fileSlug)) {
						fs.writeFileSync(indexPath, indexContent.trimEnd() + "\n" + wikilink + "\n");
					}
					break;
				}
			}

			// Re-index
			if (qmdAvailable) {
				qmdEmbed(qmdCollection, activePackPath).catch(() => {});
			}

			const rel = path.relative(activePackPath, filePath);
			return {
				content: [{ type: "text" as const, text: `Saved ${noteType}: ${rel}` }],
				details: { path: rel, action: "created", type: noteType },
			};
		},
	});

	// --- tool_result: retrieve related memory after failures ---
	pi.on("tool_result", async (event, ctx) => {
		if (!activePackPath || !activePack || !(event as any).isError) return;
		const text = JSON.stringify((event as any).content ?? "").slice(0, 500);
		if (!text.trim()) return;
		const result = await searchPackMemory(activePackPath, text, 2, "keyword");
		if (result.matchCount > 0 && !isNoResultText(result.text) && ctx.hasUI) {
			ctx.ui.setWidget("memctx-tool-failure", [
				"\x1b[33m💡 memctx: Found memory that may help with the failed tool call.\x1b[0m",
				truncate(result.text.replace(/\n+/g, " "), 300),
			]);
			setTimeout(() => ctx.hasUI && ctx.ui.setWidget("memctx-tool-failure", []), 20000);
		}
	});

	// --- agent_end: propose or save learnings ---
	pi.on("agent_end", async (event, ctx) => {
		if (!activePackPath || !activePack || autosaveMode === "off") return;

		const messages = (event as any).messages ?? [];
		let hasToolCalls = false;
		let hasWrites = false;
		const snippets: string[] = [];

		for (const msg of messages) {
			const m = msg.type === "message" ? msg.message : msg;
			if (!m) continue;
			if (m.role === "user" && typeof m.content === "string") snippets.push(`User: ${truncate(m.content, 300)}`);
			if (m.role === "assistant" && Array.isArray(m.content)) {
				for (const block of m.content) {
					if (block.type === "text" && block.text) snippets.push(`Assistant: ${truncate(block.text, 300)}`);
					if (block.type === "toolCall") {
						hasToolCalls = true;
						if (["write", "edit", "bash"].includes(block.name)) hasWrites = true;
						snippets.push(`Tool: ${block.name}`);
					}
				}
			}
		}

		if (!hasToolCalls && !hasWrites) return;
		let candidate: MemoryCandidate | null = null;
		if (llmMode !== "off" && ctx.model) {
			const generated = await completeJsonWithLlm<Partial<MemoryCandidate> & { shouldSave?: boolean }>(ctx, "autosave-memory-candidate", [
				"Decide whether this coding-agent turn contains durable memory worth saving.",
				"Return ONLY JSON with shouldSave, type, title, content, tags[], confidence 0..1, reason.",
				"Save only durable project knowledge: decisions, completed actions, conventions, runbooks, architecture/context. Do not save secrets or transient chatter.",
			].join("\n"), { activePack, autosaveMode, snippets: snippets.slice(-20) });
			if (generated?.shouldSave && generated.title && generated.content && NOTE_TYPES.includes(generated.type as NoteType)) {
				candidate = {
					id: `mem-${Date.now().toString(36)}`,
					type: generated.type as NoteType,
					title: generated.title,
					content: generated.content,
					tags: Array.isArray(generated.tags) ? generated.tags : ["autosave"],
					confidence: typeof generated.confidence === "number" ? generated.confidence : 0.7,
					reason: generated.reason ?? "LLM autosave candidate",
					createdAt: nowTimestamp(),
					pack: activePack,
				};
			}
		}
		if (!candidate && hasWrites) {
			candidate = {
				id: `mem-${Date.now().toString(36)}`,
				type: "action",
				title: `Session changes ${todayStr()}`,
				content: `A Pi session made code or command changes. Review the session before relying on this note.\n\n${snippets.slice(-8).join("\n")}`,
				tags: ["autosave", "session"],
				confidence: 0.55,
				reason: "Detected write/edit/bash activity",
				createdAt: nowTimestamp(),
				pack: activePack,
			};
		}
		if (!candidate || sensitivePatternHit(candidate.title, candidate.content)) return;

		if (autosaveMode === "auto") {
			if (candidate.confidence >= 0.85) {
				try {
					const saved = saveMemoryCandidate(candidate);
					if (qmdAvailable) qmdEmbed(qmdCollection, activePackPath).catch(() => {});
					if (ctx.hasUI) ctx.ui.notify(`memctx: Autosaved ${candidate.type}: ${saved.rel}`, "info");
				} catch {
					enqueueMemoryCandidate(candidate);
				}
			} else if (autosaveQueueLowConfidence) {
				enqueueMemoryCandidate(candidate);
				if (ctx.hasUI) ctx.ui.notify(`memctx: Queued low-confidence autosave candidate: ${candidate.title}`, "info");
			}
			return;
		}

		if (autosaveMode === "confirm" && ctx.hasUI) {
			const approved = await ctx.ui.confirm("Save memory candidate?", `${candidate.type}: ${candidate.title}\n\n${truncate(candidate.content, 500)}`);
			if (approved) {
				try {
					const saved = saveMemoryCandidate(candidate);
					if (qmdAvailable) qmdEmbed(qmdCollection, activePackPath).catch(() => {});
					ctx.ui.notify(`memctx: Saved ${candidate.type}: ${saved.rel}`, "info");
					return;
				} catch (err) {
					ctx.ui.notify(`memctx: Could not save candidate: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
			}
		}

		enqueueMemoryCandidate(candidate);
		if (ctx.hasUI) {
			ctx.ui.setWidget("memctx-learn", [
				`\x1b[33m💡 memctx: Memory candidate queued (${candidate.type}, ${Math.round(candidate.confidence * 100)}%).\x1b[0m`,
				`   ${candidate.title}`,
				`   Review: /memctx-save-queue approve ${candidate.id}`,
			]);
			setTimeout(() => ctx.hasUI && ctx.ui.setWidget("memctx-learn", []), 30000);
		}
	});
}

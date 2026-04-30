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

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

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
let qmdCollection = "";

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
 * Reads the pack's resource-map and context files looking for repo names
 * that match the cwd basename or parent directories.
 */
export function scorePackForCwd(packPath: string, cwd: string): number {
	const cwdParts = cwd.split(path.sep).filter(Boolean);
	// Collect the last 3 path segments as candidates (e.g. "project-a", "service-api", "module")
	const candidates = cwdParts.slice(-3).map((p) => p.toLowerCase());
	if (candidates.length === 0) return 0;

	// Scan all markdown files in the pack for mentions of cwd segments
	const files = scanPackFiles(packPath);
	let score = 0;

	for (const f of files) {
		const content = readFileSafe(f);
		if (!content) continue;
		const contentLower = content.toLowerCase();
		for (const candidate of candidates) {
			if (candidate.length >= 3 && contentLower.includes(candidate)) {
				score++;
			}
		}
	}

	return score;
}

export function detectActivePack(packsDir: string, cwd?: string): string | null {
	const packs = listPacks(packsDir);
	if (packs.length === 0) return null;
	if (packs.length === 1) return packs[0];

	// Auto-detect by cwd: score each pack and pick the best match
	if (cwd) {
		const scored = packs
			.map((pack) => ({ pack, score: scorePackForCwd(path.join(packsDir, pack), cwd) }))
			.filter((s) => s.score > 0)
			.sort((a, b) => b.score - a.score);
		if (scored.length > 0) return scored[0].pack;
	}

	// Fallback: prefer one with a manifest
	for (const pack of packs) {
		const manifestDir = path.join(packsDir, pack, "00-system");
		if (fs.existsSync(manifestDir)) return pack;
	}
	return packs[0];
}

export async function detectQmd(): Promise<boolean> {
	return new Promise((resolve) => {
		execFile("qmd", ["--version"], { timeout: 5000 }, (err) => {
			resolve(!err);
		});
	});
}

export async function qmdSearch(
	query: string,
	collection: string,
	limit = 5,
	mode: "keyword" | "semantic" | "deep" = "keyword",
): Promise<string> {
	if (!qmdAvailable) return "";
	return new Promise((resolve) => {
		const args = ["search", query, "-n", String(limit), "-c", collection];
		if (mode === "semantic") args.push("--semantic");
		else if (mode === "deep") args.push("--deep");

		execFile("qmd", args, { timeout: mode === "deep" ? 15000 : 5000 }, (err, stdout) => {
			if (err) {
				resolve("");
				return;
			}
			resolve(stdout.trim());
		});
	});
}

export async function qmdEmbed(collection: string, packPath: string): Promise<boolean> {
	if (!qmdAvailable) return false;
	return new Promise((resolve) => {
		execFile("qmd", ["embed", "-c", collection, packPath], { timeout: 30000 }, (err) => {
			resolve(!err);
		});
	});
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

/**
 * Build prioritized context from a pack for injection into the system prompt.
 */
export function buildPackContext(packPath: string, searchResults?: string): string {
	const sections: { key: string; header: string; content: string }[] = [];

	// 1. Manifest (highest priority) — skip empty template indexes
	const manifestDir = path.join(packPath, "00-system");
	if (fs.existsSync(manifestDir)) {
		const manifestFiles = scanPackFiles(manifestDir);
		const manifestParts: string[] = [];
		for (const f of manifestFiles) {
			const content = readFileSafe(f);
			if (!content?.trim()) continue;
			// Skip empty template indexes (contain only "<Add wikilink>")
			if (content.includes("<Add wikilink>") && !content.includes("[[packs/")) continue;
			const rel = path.relative(packPath, f);
			manifestParts.push(`### ${rel}\n${content.trim()}`);
		}
		if (manifestParts.length > 0) {
			sections.push({
				key: "manifest",
				header: "## Pack System (manifest, indexes, retrieval protocol)",
				content: truncate(manifestParts.join("\n\n"), BUDGET.manifest),
			});
		}
	}

	// 2. Source-of-truth pointers (context packs)
	const contextDir = path.join(packPath, "20-context");
	if (fs.existsSync(contextDir)) {
		const contextFiles = scanPackFiles(contextDir);
		const contextParts: string[] = [];
		for (const f of contextFiles.slice(0, 5)) {
			const content = readFileSafe(f);
			if (content?.trim()) {
				const rel = path.relative(packPath, f);
				contextParts.push(`### ${rel}\n${content.trim()}`);
			}
		}
		if (contextParts.length > 0) {
			sections.push({
				key: "sourceOfTruth",
				header: "## Context Packs (source-of-truth pointers)",
				content: truncate(contextParts.join("\n\n"), BUDGET.sourceOfTruth),
			});
		}
	}

	// 3. Search results
	if (searchResults?.trim()) {
		sections.push({
			key: "searchResults",
			header: "## Relevant Memory (search results)",
			content: truncate(searchResults, BUDGET.searchResults),
		});
	}

	// 4. Recent actions
	const actionsDir = path.join(packPath, "40-actions");
	if (fs.existsSync(actionsDir)) {
		const actionFiles = scanPackFiles(actionsDir).slice(0, 5);
		const actionParts: string[] = [];
		for (const f of actionFiles) {
			const content = readFileSafe(f);
			if (content?.trim()) {
				const rel = path.relative(packPath, f);
				actionParts.push(`### ${rel}\n${content.trim()}`);
			}
		}
		if (actionParts.length > 0) {
			sections.push({
				key: "recentActions",
				header: "## Recent Actions",
				content: truncate(actionParts.join("\n\n"), BUDGET.recentActions),
			});
		}
	}

	// 5. Active decisions
	const decisionsDir = ["50-decisions", "30-decisions"]
		.map((d) => path.join(packPath, d))
		.find((d) => fs.existsSync(d));
	if (decisionsDir) {
		const decisionFiles = scanPackFiles(decisionsDir).slice(0, 5);
		const decisionParts: string[] = [];
		for (const f of decisionFiles) {
			const content = readFileSafe(f);
			if (content?.trim()) {
				const rel = path.relative(packPath, f);
				decisionParts.push(`### ${rel}\n${content.trim()}`);
			}
		}
		if (decisionParts.length > 0) {
			sections.push({
				key: "decisions",
				header: "## Active Decisions",
				content: truncate(decisionParts.join("\n\n"), BUDGET.decisions),
			});
		}
	}

	// 6. Runbooks
	const runbooksDir = ["70-runbooks", "80-runbooks"]
		.map((d) => path.join(packPath, d))
		.find((d) => fs.existsSync(d));
	if (runbooksDir) {
		const runbookFiles = scanPackFiles(runbooksDir).slice(0, 3);
		const runbookParts: string[] = [];
		for (const f of runbookFiles) {
			const content = readFileSafe(f);
			if (content?.trim()) {
				const rel = path.relative(packPath, f);
				runbookParts.push(`### ${rel}\n${content.trim()}`);
			}
		}
		if (runbookParts.length > 0) {
			sections.push({
				key: "runbooks",
				header: "## Runbooks",
				content: truncate(runbookParts.join("\n\n"), BUDGET.runbooks),
			});
		}
	}

	// Apply total budget — trim from lowest priority
	const result: string[] = [];
	let totalChars = 0;

	for (const section of sections) {
		const sectionText = `${section.header}\n\n${section.content}`;
		if (totalChars + sectionText.length > BUDGET.total) {
			const remaining = BUDGET.total - totalChars;
			if (remaining > 200) {
				result.push(truncate(sectionText, remaining));
			}
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

/**
 * Scan a directory tree and generate a pack from its contents.
 * Reads README.md, CLAUDE.md, AGENTS.md, go.mod, package.json,
 * Makefile, Dockerfile, and directory structure to build context.
 */
export function generatePackFromDirectory(
	scanDir: string,
	packSlug: string,
	packsDir: string,
): { packPath: string; filesCreated: string[] } {
	const packPath = path.join(packsDir, packSlug);
	const filesCreated: string[] = [];
	const today = new Date().toISOString().slice(0, 10);
	const title = packSlug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

	// Create directory structure
	for (const dir of [
		"00-system/pi-agent",
		"00-system/indexes",
		"20-context",
		"50-decisions",
		"70-runbooks",
	]) {
		fs.mkdirSync(path.join(packPath, dir), { recursive: true });
	}

	// Scan for repos (directories with go.mod, package.json, or README.md)
	const repos: { name: string; type: string; description: string; path: string }[] = [];
	const topDirs = fs.existsSync(scanDir)
		? fs.readdirSync(scanDir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith("."))
		: [];

	for (const entry of topDirs) {
		const dirPath = path.join(scanDir, entry.name);
		let type = "unknown";
		let description = "";

		if (fs.existsSync(path.join(dirPath, "go.mod"))) {
			type = "Go";
			const gomod = readFileSafe(path.join(dirPath, "go.mod"));
			const moduleLine = gomod?.match(/^module\s+(.+)$/m);
			if (moduleLine) description = moduleLine[1];
		} else if (fs.existsSync(path.join(dirPath, "package.json"))) {
			type = "Node/TS";
			try {
				const pkg = JSON.parse(readFileSafe(path.join(dirPath, "package.json")) ?? "{}");
				description = pkg.description ?? pkg.name ?? "";
			} catch { /* ignore */ }
		} else if (fs.existsSync(path.join(dirPath, "infra")) || fs.existsSync(path.join(dirPath, "terraform"))) {
			type = "IaC";
		}

		// Read README for description
		for (const readmeFile of ["README.md", "CLAUDE.md", "AGENTS.md"]) {
			const readme = readFileSafe(path.join(dirPath, readmeFile));
			if (readme) {
				// Extract first meaningful line after heading
				const lines = readme.split("\n").filter((l) => l.trim() && !l.startsWith("#") && !l.startsWith("<") && !l.startsWith("["));
				if (lines.length > 0 && !description) {
					description = lines[0].trim().slice(0, 200);
				}
				break;
			}
		}

		repos.push({ name: entry.name, type, description: description || entry.name, path: dirPath });
	}

	// --- Generate manifest ---
	const manifestContent = `---
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

This pack stores context for **${title}**.

## Pack root

\`packs/${packSlug}\`

## Indexes

- [[packs/${packSlug}/00-system/indexes/context-index|Context Index]]

## Safety

Never store secrets, tokens, passwords, private keys, credentials, or sensitive data.
`;
	const manifestPath = path.join(packPath, "00-system/pi-agent/memory-manifest.md");
	fs.writeFileSync(manifestPath, manifestContent);
	filesCreated.push(manifestPath);

	// --- Generate resource-map ---
	const repoTable = repos
		.map((r) => `| \`${r.name}\` | ${r.type} | ${r.description.slice(0, 100)} |`)
		.join("\n");

	const resourceMapContent = `---
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

## Repositories

| Name | Type | Description |
|---|---|---|
${repoTable}

## Source directory

\`${scanDir}\`
`;
	const resourceMapPath = path.join(packPath, "00-system/pi-agent/resource-map.md");
	fs.writeFileSync(resourceMapPath, resourceMapContent);
	filesCreated.push(resourceMapPath);

	// --- Generate context pack per repo ---
	const contextEntries: string[] = [];

	for (const repo of repos) {
		const parts: string[] = [];

		// Read README
		const readme = readFileSafe(path.join(repo.path, "README.md"));
		if (readme) {
			parts.push(truncate(readme, 3000));
		}

		// Read CLAUDE.md or AGENTS.md for build/deploy commands
		for (const agentFile of ["CLAUDE.md", "AGENTS.md"]) {
			const content = readFileSafe(path.join(repo.path, agentFile));
			if (content) {
				parts.push(`## From ${agentFile}\n\n${truncate(content, 2000)}`);
				break;
			}
		}

		// Scan top-level structure
		const topLevel = fs.readdirSync(repo.path, { withFileTypes: true })
			.filter((e) => !e.name.startsWith(".") && e.name !== "node_modules" && e.name !== "vendor")
			.map((e) => e.isDirectory() ? `${e.name}/` : e.name)
			.slice(0, 30);
		parts.push(`## Directory structure\n\n\`\`\`\n${topLevel.join("\n")}\n\`\`\``);

		const contextContent = `---
type: context-pack
id: context.${packSlug}.${repo.name}
title: ${repo.name}
status: active
source_of_truth: false
freshness: current
last_reviewed: ${today}
tags:
  - pack/${packSlug}
  - agent-memory/context-pack
  - repo/${repo.name}
---

# ${repo.name}

**Type:** ${repo.type}  
**Description:** ${repo.description}

${parts.join("\n\n")}

## Related

- [[packs/${packSlug}/00-system/pi-agent/resource-map|Resource Map]]
`;
		const contextPath = path.join(packPath, `20-context/${repo.name}.md`);
		fs.writeFileSync(contextPath, contextContent);
		filesCreated.push(contextPath);

		contextEntries.push(
			`| [[packs/${packSlug}/20-context/${repo.name}\\|${repo.name}]] | ${repo.type} — ${repo.description.slice(0, 60)} |`,
		);
	}

	// --- Generate context index ---
	const contextIndexContent = `---
type: index
id: index.${packSlug}.context-index
title: Context Index
status: active
source_of_truth: true
freshness: current
last_reviewed: ${today}
tags:
  - agent-memory/index
  - pack/${packSlug}
---

# Context Index

| Note | Use |
|---|---|
${contextEntries.join("\n")}
`;
	const contextIndexPath = path.join(packPath, "00-system/indexes/context-index.md");
	fs.writeFileSync(contextIndexPath, contextIndexContent);
	filesCreated.push(contextIndexPath);

	return { packPath, filesCreated };
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
}
export function _setQmdAvailable(available: boolean) {
	qmdAvailable = available;
}
export function _resetState() {
	vaultRoot = "";
	activePack = "";
	activePackPath = "";
	qmdAvailable = false;
	qmdCollection = "";
	_packsDir = "";
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// --- session_start: detect vault, active pack, qmd ---
	pi.on("session_start", async (_event, ctx) => {
		// Resolve packs directory
		const packsDir = resolvePacksDir(ctx.cwd);

		if (!packsDir) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					"memctx: No packs found. Set MEMCTX_PACKS_PATH, create .pi/memory-vault/packs/, or use ~/.pi/agent/memory-vault/packs/",
					"info",
				);
			}
			return;
		}

		vaultRoot = path.dirname(packsDir);
		_packsDir = packsDir;
		const detected = detectActivePack(packsDir, ctx.cwd);

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
			const qmdStatus = qmdAvailable ? "qmd ✓" : "qmd ✗ (keyword search only)";
			ctx.ui.notify(`memctx: Pack "${activePack}" loaded. ${qmdStatus}`, "info");
			ctx.ui.setStatus("memctx", `📦 ${activePack}`);
		}
	});

	// --- before_agent_start: inject pack context ---
	pi.on("before_agent_start", async (event, _ctx) => {
		if (!activePackPath) return;

		// Semantic search for relevant memories
		let searchResults = "";
		if (qmdAvailable && event.prompt) {
			const sanitized = (event.prompt ?? "").replace(/[^\w\s.,?!-]/g, "").slice(0, 200);
			if (sanitized.trim()) {
				searchResults = await qmdSearch(sanitized, qmdCollection, 3);
			}
		}

		const packContext = buildPackContext(activePackPath, searchResults);
		if (!packContext) return;

		const injection = [
			"\n\n## Memory Context",
			`Active pack: \`${activePack}\``,
			"The following memory context has been loaded from the pack.",
			"Use the memctx_search tool to find additional context across pack files.",
			"",
			packContext,
		].join("\n");

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

		const summary = recentMessages.join("\n");
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

	// --- /pack command: list and switch packs ---
	pi.registerCommand("pack", {
		description: "List or switch memory packs. Usage: /pack [name]",
		handler: async (args, ctx) => {
			const packsDir = _packsDir || resolvePacksDir(ctx.cwd);
			if (!packsDir) {
				ctx.ui.notify("memctx: No packs found. Use /pack-generate to create one.", "error");
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

				activePack = packName;
				activePackPath = path.join(packsDir, packName);
				qmdCollection = `memctx-${packName}`;

				if (qmdAvailable) {
					qmdEmbed(qmdCollection, activePackPath).catch(() => {});
				}

				ctx.ui.notify(`memctx: Switched to pack "${activePack}".`, "info");
				ctx.ui.setStatus("memctx", `📦 ${activePack}`);
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

			activePack = target;
			activePackPath = path.join(packsDir, target);
			qmdCollection = `memctx-${target}`;

			if (qmdAvailable) {
				qmdEmbed(qmdCollection, activePackPath).catch(() => {});
			}

			ctx.ui.notify(`memctx: Switched to pack "${activePack}".`, "info");
			ctx.ui.setStatus("memctx", `📦 ${activePack}`);
		},
	});

	// --- /pack-generate command: generate a pack from a directory ---
	pi.registerCommand("pack-generate", {
		description: "Generate a memory pack from a directory of repos. Usage: /pack-generate [path] [slug]",
		handler: async (args, ctx) => {
			// Resolve packs directory — create default if none exists
			let packsDir = _packsDir;
			if (!packsDir) {
				// Try to find existing packs dir
				packsDir = resolvePacksDir(ctx.cwd);
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
			ctx.ui.setStatus("memctx", `📦 ${activePack}`);
		},
	});

	// --- memctx_search tool ---
	pi.registerTool({
		name: "memctx_search",
		label: "Memory Search",
		description: [
			"Search across memory context pack files for relevant context.",
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
			if (!activePackPath) {
				return {
					content: [{ type: "text" as const, text: "No active memory pack. Install a pack under packs/ first." }],
					details: {},
				};
			}

			const { query, mode = "keyword", limit = 5 } = params;

			// Try qmd first
			if (qmdAvailable) {
				const results = await qmdSearch(query, qmdCollection, limit, mode as any);
				if (results) {
					return {
						content: [{ type: "text" as const, text: results }],
						details: { mode, collection: qmdCollection },
					};
				}
			}

			// Fallback: grep-based search
			const files = scanPackFiles(activePackPath);
			const matches: string[] = [];
			const queryLower = query.toLowerCase();
			const terms = queryLower.split(/\s+/).filter(Boolean);

			for (const f of files) {
				if (matches.length >= limit) break;
				const content = readFileSafe(f);
				if (!content) continue;
				const contentLower = content.toLowerCase();
				const score = terms.filter((t) => contentLower.includes(t)).length;
				if (score > 0) {
					const rel = path.relative(activePackPath, f);
					// Extract matching lines
					const lines = content.split("\n");
					const matchingLines = lines
						.filter((line) => terms.some((t) => line.toLowerCase().includes(t)))
						.slice(0, 5);
					matches.push(`### ${rel} (${score}/${terms.length} terms matched)\n${matchingLines.join("\n")}`);
				}
			}

			if (matches.length === 0) {
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
					? "\n\nTry switching pack: " + crossResults.map((p) => "/pack " + p).join(", ")
					: "";

				return {
					content: [{
						type: "text" as const,
						text: `No results for "${query}" in pack "${activePack}".${hint}`,
					}],
					details: { mode: qmdAvailable ? mode : "grep-fallback", crossPackHints: crossResults },
				};
			}

			return {
				content: [
					{
						type: "text" as const,
						text: `## Search results (grep fallback, qmd not available)\n\n${matches.join("\n\n")}`,
					},
				],
				details: { mode: "grep-fallback", matchCount: matches.length },
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

	// --- agent_end: propose learnings ---
	pi.on("agent_end", async (event, ctx) => {
		if (!activePackPath || !activePack) return;

		// Check if the agent used tool calls that discovered something
		const messages = (event as any).messages ?? [];
		let hasToolCalls = false;
		let hasWrites = false;

		for (const msg of messages) {
			if (msg.type !== "message") continue;
			const m = msg.message;
			if (!m || m.role !== "assistant" || !Array.isArray(m.content)) continue;
			for (const block of m.content) {
				if (block.type === "toolCall") {
					hasToolCalls = true;
					if (["write", "edit", "bash"].includes(block.name)) {
						hasWrites = true;
					}
				}
			}
		}

		// Only nudge after substantial work (tool calls + writes)
		if (hasToolCalls && hasWrites && ctx.hasUI) {
			ctx.ui.setWidget("memctx-learn", [
				"\x1b[33m💡 memctx: This session made changes. Save learnings with memctx_save?\x1b[0m",
				"   Ask: \"save what we learned to memory\" or use memctx_save directly.",
			]);
			// Clear the widget after 30 seconds
			setTimeout(() => {
				if (ctx.hasUI) ctx.ui.setWidget("memctx-learn", []);
			}, 30000);
		}
	});
}

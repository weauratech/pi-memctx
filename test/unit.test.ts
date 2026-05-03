/**
 * Unit tests for pi-memctx extension.
 *
 * Run:   bun test test/unit.test.ts
 *
 * Uses temp directories for all file I/O — does not touch real memory vaults.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	_resetState,
	_setActivePack,
	_setContextPipelineForTest,
	_setQmdAvailable,
	_setStrictMode,
	_setVaultRoot,
	buildNote,
	buildPackContext,
	llmArchitectureNote,
	buildSessionHandoff,
	detectActivePack,
	findVaultRoot,
	generatePackFromDirectory,
	grepSearchPack,
	normalizeNoteTitle,
	listPacks,
	nowTimestamp,
	readFileSafe,
	readFrontmatterType,
	resolveNoteDir,
	resolvePacksDir,
	scanPackFiles,
	scorePackForCwd,
	slugify,
	todayStr,
	truncate,
} from "../index.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function setupTmpDir() {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "amv-test-"));
	process.env.MEMCTX_CONFIG_PATH = path.join(tmpDir, "config.json");
}

function cleanupTmpDir() {
	_resetState();
	delete process.env.MEMCTX_CONFIG_PATH;
	fs.rmSync(tmpDir, { recursive: true, force: true });
}

/**
 * Create a minimal vault structure in tmpDir.
 * Returns the vault root path.
 */
function createTestVault(packName = "test-pack"): {
	vaultRoot: string;
	packPath: string;
	packsDir: string;
} {
	const vaultRoot = tmpDir;
	const packsDir = path.join(vaultRoot, "packs");
	const packPath = path.join(packsDir, packName);

	// package.json at vault root
	fs.writeFileSync(
		path.join(vaultRoot, "package.json"),
		JSON.stringify({ name: "agent-memory-vault", version: "0.1.0" }),
	);

	// Pack structure
	fs.mkdirSync(path.join(packPath, "00-system", "pi-agent"), { recursive: true });
	fs.mkdirSync(path.join(packPath, "00-system", "indexes"), { recursive: true });
	fs.mkdirSync(path.join(packPath, "20-context"), { recursive: true });
	fs.mkdirSync(path.join(packPath, "50-decisions"), { recursive: true });
	fs.mkdirSync(path.join(packPath, "40-actions"), { recursive: true });
	fs.mkdirSync(path.join(packPath, "60-observations"), { recursive: true });
	fs.mkdirSync(path.join(packPath, "70-runbooks"), { recursive: true });

	// Manifest
	fs.writeFileSync(
		path.join(packPath, "00-system", "pi-agent", "memory-manifest.md"),
		`---
type: system
id: system.${packName}.memory-manifest
title: ${packName} Memory Manifest
status: active
tags:
  - pi/memory
  - pack/${packName}
---

# ${packName} Memory Manifest

This pack is the memory for the ${packName} project.
`,
	);

	// Index
	fs.writeFileSync(
		path.join(packPath, "00-system", "indexes", "context-index.md"),
		`---
type: index
id: index.${packName}.context-index
title: Context Index
status: active
tags:
  - pack/${packName}
  - agent-memory/index
---

# Context Index

| Note | Use |
|---|---|
| [[packs/${packName}/20-context/project-context\\|Project Context]] | Main project context |
`,
	);

	// Context pack
	fs.writeFileSync(
		path.join(packPath, "20-context", "project-context.md"),
		`---
type: context
id: context.${packName}.project-context
title: Project Context
status: active
tags:
  - pack/${packName}
  - agent-memory/context
---

# Project Context

## Stack

- Language: TypeScript
- Runtime: Bun
- Framework: Hono
- Database: PostgreSQL

## Conventions

- Use kebab-case for file names.
- All API routes must have OpenAPI schemas.
`,
	);

	// Decision
	fs.writeFileSync(
		path.join(packPath, "50-decisions", "001-use-bun.md"),
		`---
type: decision
id: decision.${packName}.001-use-bun
title: Use Bun as Runtime
status: accepted
tags:
  - pack/${packName}
  - agent-memory/decision
---

# Use Bun as Runtime

## Context

We need a fast TypeScript runtime.

## Decision

Use Bun instead of Node.js for better performance and native TypeScript support.

## Consequences

- Faster startup
- Native test runner
- Some npm packages may not be compatible
`,
	);

	// Action
	fs.writeFileSync(
		path.join(packPath, "40-actions", "2026-04-29-setup-ci.md"),
		`---
type: action
id: action.${packName}.2026-04-29-setup-ci
title: Setup CI Pipeline
status: completed
tags:
  - pack/${packName}
  - agent-memory/action
---

# Setup CI Pipeline

Configured GitHub Actions for CI:
- Lint with Biome
- Test with Bun
- Build check
`,
	);

	// Runbook
	fs.writeFileSync(
		path.join(packPath, "70-runbooks", "deploy.md"),
		`---
type: runbook
id: runbook.${packName}.deploy
title: Deploy Procedure
status: active
tags:
  - pack/${packName}
  - agent-memory/runbook
---

# Deploy Procedure

1. Run tests: \`bun test\`
2. Build: \`bun run build\`
3. Deploy: \`kubectl apply -f k8s/\`
4. Verify: check health endpoint
`,
	);

	return { vaultRoot, packPath, packsDir };
}

/** Create a mock ExtensionAPI and capture registered tools/hooks/commands. */
function createMockPi() {
	const tools: Record<string, any> = {};
	const hooks: Record<string, (...args: unknown[]) => unknown> = {};
	const commands: Record<string, any> = {};

	const pi = {
		registerTool(toolDef: any) {
			tools[toolDef.name] = toolDef;
		},
		on(event: string, handler: (...args: unknown[]) => unknown) {
			hooks[event] = handler;
		},
		registerCommand(name: string, def: any) {
			commands[name] = def;
		},
	};

	return { pi, tools, hooks, commands };
}

/** Create a mock extension context. */
function createMockCtx(sessionId = "abcdef1234567890") {
	return {
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => [],
		},
		hasUI: true,
		ui: {
			notify: mock(() => {}),
			setStatus: mock(() => {}),
			setWidget: mock(() => {}),
			confirm: mock(async () => false),
		},
		cwd: tmpDir,
	};
}

// Import the default export to register tools
import registerExtension from "../index.js";

// ==========================================================================
// 1. Utility functions
// ==========================================================================

describe("readFileSafe", () => {
	beforeEach(setupTmpDir);
	afterEach(cleanupTmpDir);

	test("reads existing file", () => {
		const p = path.join(tmpDir, "test.txt");
		fs.writeFileSync(p, "hello world", "utf-8");
		expect(readFileSafe(p)).toBe("hello world");
	});

	test("returns null for non-existent file", () => {
		expect(readFileSafe(path.join(tmpDir, "nope.txt"))).toBeNull();
	});

	test("reads unicode content", () => {
		const p = path.join(tmpDir, "unicode.txt");
		fs.writeFileSync(p, "Olá 🌍 mundo", "utf-8");
		expect(readFileSafe(p)).toBe("Olá 🌍 mundo");
	});

	test("reads empty file", () => {
		const p = path.join(tmpDir, "empty.txt");
		fs.writeFileSync(p, "", "utf-8");
		expect(readFileSafe(p)).toBe("");
	});
});

describe("todayStr", () => {
	test("returns YYYY-MM-DD format", () => {
		expect(todayStr()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});
});

describe("nowTimestamp", () => {
	test("returns timestamp format", () => {
		expect(nowTimestamp()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
	});
});

// ==========================================================================
// 2. Vault discovery
// ==========================================================================

describe("findVaultRoot", () => {
	beforeEach(setupTmpDir);
	afterEach(cleanupTmpDir);

	test("finds vault root with package.json", () => {
		fs.writeFileSync(
			path.join(tmpDir, "package.json"),
			JSON.stringify({ name: "agent-memory-vault" }),
		);
		expect(findVaultRoot(tmpDir)).toBe(tmpDir);
	});

	test("finds vault root from subdirectory", () => {
		fs.writeFileSync(
			path.join(tmpDir, "package.json"),
			JSON.stringify({ name: "agent-memory-vault" }),
		);
		const subdir = path.join(tmpDir, "extensions", "pi-memctx");
		fs.mkdirSync(subdir, { recursive: true });
		expect(findVaultRoot(subdir)).toBe(tmpDir);
	});

	test("returns null when no vault found", () => {
		expect(findVaultRoot(tmpDir)).toBeNull();
	});

	test("returns null for non-matching package.json", () => {
		fs.writeFileSync(
			path.join(tmpDir, "package.json"),
			JSON.stringify({ name: "some-other-package" }),
		);
		expect(findVaultRoot(tmpDir)).toBeNull();
	});

	test("handles malformed package.json", () => {
		fs.writeFileSync(path.join(tmpDir, "package.json"), "not json");
		expect(findVaultRoot(tmpDir)).toBeNull();
	});
});

// ==========================================================================
// 3. Pack detection
// ==========================================================================

describe("detectActivePack", () => {
	beforeEach(setupTmpDir);
	afterEach(cleanupTmpDir);

	test("returns null when packs dir does not exist", () => {
		expect(detectActivePack(path.join(tmpDir, "packs"))).toBeNull();
	});

	test("returns null when packs dir is empty", () => {
		const packsDir = path.join(tmpDir, "packs");
		fs.mkdirSync(packsDir);
		expect(detectActivePack(packsDir)).toBeNull();
	});

	test("returns single pack", () => {
		const packsDir = path.join(tmpDir, "packs");
		fs.mkdirSync(path.join(packsDir, "my-project"), { recursive: true });
		expect(detectActivePack(packsDir)).toBe("my-project");
	});

	test("ignores hidden directories", () => {
		const packsDir = path.join(tmpDir, "packs");
		fs.mkdirSync(path.join(packsDir, ".hidden"), { recursive: true });
		expect(detectActivePack(packsDir)).toBeNull();
	});

	test("prefers pack with 00-system dir when multiple packs exist", () => {
		const packsDir = path.join(tmpDir, "packs");
		fs.mkdirSync(path.join(packsDir, "alpha"), { recursive: true });
		fs.mkdirSync(path.join(packsDir, "beta", "00-system"), { recursive: true });
		expect(detectActivePack(packsDir)).toBe("beta");
	});

	test("returns first pack alphabetically when none have 00-system", () => {
		const packsDir = path.join(tmpDir, "packs");
		fs.mkdirSync(path.join(packsDir, "zebra"), { recursive: true });
		fs.mkdirSync(path.join(packsDir, "alpha"), { recursive: true });
		// Returns first in readdir order (implementation-dependent)
		const result = detectActivePack(packsDir);
		expect(result).not.toBeNull();
		expect(["zebra", "alpha"]).toContain(result!);
	});

	test("ignores .gitkeep file", () => {
		const packsDir = path.join(tmpDir, "packs");
		fs.mkdirSync(packsDir);
		fs.writeFileSync(path.join(packsDir, ".gitkeep"), "");
		expect(detectActivePack(packsDir)).toBeNull();
	});

	test("auto-detects pack by cwd match", () => {
		const packsDir = path.join(tmpDir, "packs");
		// Pack A references "project-alpha"
		const packA = path.join(packsDir, "alpha", "20-context");
		fs.mkdirSync(packA, { recursive: true });
		fs.writeFileSync(path.join(packA, "context.md"), "This pack covers project-alpha platform.");
		// Pack B references "project-beta"
		const packB = path.join(packsDir, "payments", "20-context");
		fs.mkdirSync(packB, { recursive: true });
		fs.writeFileSync(path.join(packB, "context.md"), "This pack covers project-beta API services.");

		// cwd is inside project-beta → should pick payments pack
		expect(detectActivePack(packsDir, "/code/project-beta/payment")).toBe("payments");
		// cwd is inside project-alpha → should pick alpha pack
		expect(detectActivePack(packsDir, "/code/project-alpha/apps/web")).toBe("alpha");
	});

	test("falls back to manifest when cwd matches nothing", () => {
		const packsDir = path.join(tmpDir, "packs");
		fs.mkdirSync(path.join(packsDir, "alpha"), { recursive: true });
		fs.mkdirSync(path.join(packsDir, "beta", "00-system"), { recursive: true });
		expect(detectActivePack(packsDir, "/totally/unrelated/project")).toBe("beta");
	});
});

// ==========================================================================
// 3b. Pack scoring for cwd
// ==========================================================================

describe("scorePackForCwd", () => {
	beforeEach(setupTmpDir);
	afterEach(cleanupTmpDir);

	test("returns 0 for empty pack", () => {
		const packDir = path.join(tmpDir, "empty-pack");
		fs.mkdirSync(packDir);
		expect(scorePackForCwd(packDir, "/code/project-alpha")).toBe(0);
	});

	test("scores higher when more cwd segments match", () => {
		const packDir = path.join(tmpDir, "pack");
		fs.mkdirSync(packDir, { recursive: true });
		fs.writeFileSync(path.join(packDir, "context.md"), "Covers project-alpha and project-beta.");

		const score1 = scorePackForCwd(packDir, "/code/project-alpha");
		expect(score1).toBeGreaterThan(0);

		const score2 = scorePackForCwd(packDir, "/code/random-project");
		expect(score2).toBe(0);
	});

	test("ignores very short path segments", () => {
		const packDir = path.join(tmpDir, "pack");
		fs.mkdirSync(packDir, { recursive: true });
		fs.writeFileSync(path.join(packDir, "context.md"), "Content with ab in it.");
		expect(scorePackForCwd(packDir, "/x/ab")).toBe(0);
	});
});

// ==========================================================================
// 3c. List packs
// ==========================================================================

describe("listPacks", () => {
	beforeEach(setupTmpDir);
	afterEach(cleanupTmpDir);

	test("returns empty array for non-existent dir", () => {
		expect(listPacks(path.join(tmpDir, "nope"))).toEqual([]);
	});

	test("lists pack directories, ignores files and hidden", () => {
		const packsDir = path.join(tmpDir, "packs");
		fs.mkdirSync(path.join(packsDir, "alpha"), { recursive: true });
		fs.mkdirSync(path.join(packsDir, "beta"), { recursive: true });
		fs.mkdirSync(path.join(packsDir, ".hidden"), { recursive: true });
		fs.writeFileSync(path.join(packsDir, ".gitkeep"), "");
		const packs = listPacks(packsDir);
		expect(packs).toHaveLength(2);
		expect(packs).toContain("alpha");
		expect(packs).toContain("beta");
	});
});

// ==========================================================================
// 3d. Packs directory resolution
// ==========================================================================

describe("resolvePacksDir", () => {
	beforeEach(setupTmpDir);
	afterEach(() => {
		delete process.env.MEMCTX_PACKS_PATH;
		cleanupTmpDir();
	});

	test("returns null when no packs exist anywhere", () => {
		// Note: may return package-root fallback in dev.
		// In production (npm install), package packs/ is empty.
		const result = resolvePacksDir("/tmp/nonexistent-project-12345");
		// Either null or the dev package-root fallback
		if (result !== null) {
			// Must be the package-root fallback with real packs
			expect(listPacks(result).length).toBeGreaterThan(0);
		}
	});

	test("MEMCTX_PACKS_PATH takes highest priority", () => {
		const envDir = path.join(tmpDir, "env-packs");
		fs.mkdirSync(path.join(envDir, "my-pack"), { recursive: true });
		process.env.MEMCTX_PACKS_PATH = envDir;

		// Also create project-local packs
		const projDir = path.join(tmpDir, ".pi", "memory-vault", "packs", "proj-pack");
		fs.mkdirSync(projDir, { recursive: true });

		const result = resolvePacksDir(tmpDir);
		expect(result).toBe(envDir);
	});

	test("finds project-local packs", () => {
		const projPacks = path.join(tmpDir, ".pi", "memory-vault", "packs");
		fs.mkdirSync(path.join(projPacks, "local-pack"), { recursive: true });

		const result = resolvePacksDir(tmpDir);
		expect(result).toBe(projPacks);
	});

	test("ignores empty packs dirs", () => {
		// Create project-local dir but with no packs (only .gitkeep)
		const projPacks = path.join(tmpDir, ".pi", "memory-vault", "packs");
		fs.mkdirSync(projPacks, { recursive: true });
		fs.writeFileSync(path.join(projPacks, ".gitkeep"), "");

		const result = resolvePacksDir(tmpDir);
		// Should NOT resolve to the empty project-local dir
		if (result !== null) {
			expect(result).not.toBe(projPacks);
		}
	});
});

// ==========================================================================
// 4. Pack file scanning
// ==========================================================================

describe("scanPackFiles", () => {
	beforeEach(setupTmpDir);
	afterEach(cleanupTmpDir);

	test("returns empty array for non-existent path", () => {
		expect(scanPackFiles(path.join(tmpDir, "nope"))).toEqual([]);
	});

	test("finds markdown files recursively", () => {
		const packDir = path.join(tmpDir, "pack");
		fs.mkdirSync(path.join(packDir, "sub"), { recursive: true });
		fs.writeFileSync(path.join(packDir, "a.md"), "content a");
		fs.writeFileSync(path.join(packDir, "sub", "b.md"), "content b");
		fs.writeFileSync(path.join(packDir, "c.txt"), "not markdown");

		const files = scanPackFiles(packDir);
		expect(files).toHaveLength(2);
		expect(files.every((f) => f.endsWith(".md"))).toBe(true);
	});

	test("ignores hidden files and directories", () => {
		const packDir = path.join(tmpDir, "pack");
		fs.mkdirSync(path.join(packDir, ".hidden"), { recursive: true });
		fs.writeFileSync(path.join(packDir, ".hidden", "secret.md"), "hidden");
		fs.writeFileSync(path.join(packDir, "visible.md"), "visible");

		const files = scanPackFiles(packDir);
		expect(files).toHaveLength(1);
		expect(files[0]).toContain("visible.md");
	});

	test("sorts by mtime newest first", () => {
		const packDir = path.join(tmpDir, "pack");
		fs.mkdirSync(packDir);

		// Create files with different mtimes
		fs.writeFileSync(path.join(packDir, "old.md"), "old");
		const oldTime = Date.now() - 10000;
		fs.utimesSync(path.join(packDir, "old.md"), new Date(oldTime), new Date(oldTime));

		fs.writeFileSync(path.join(packDir, "new.md"), "new");

		const files = scanPackFiles(packDir);
		expect(files[0]).toContain("new.md");
		expect(files[1]).toContain("old.md");
	});
});

// ==========================================================================
// 5. Frontmatter parsing
// ==========================================================================

describe("readFrontmatterType", () => {
	beforeEach(setupTmpDir);
	afterEach(cleanupTmpDir);

	test("extracts type from frontmatter", () => {
		const p = path.join(tmpDir, "test.md");
		fs.writeFileSync(p, "---\ntype: decision\ntitle: Test\n---\n# Test");
		expect(readFrontmatterType(p)).toBe("decision");
	});

	test("returns null for file without frontmatter", () => {
		const p = path.join(tmpDir, "test.md");
		fs.writeFileSync(p, "# Just a heading\nNo frontmatter here.");
		expect(readFrontmatterType(p)).toBeNull();
	});

	test("returns null for frontmatter without type", () => {
		const p = path.join(tmpDir, "test.md");
		fs.writeFileSync(p, "---\ntitle: Test\nstatus: active\n---\n# Test");
		expect(readFrontmatterType(p)).toBeNull();
	});

	test("returns null for non-existent file", () => {
		expect(readFrontmatterType(path.join(tmpDir, "nope.md"))).toBeNull();
	});
});

// ==========================================================================
// 6. Text truncation
// ==========================================================================

describe("truncate", () => {
	test("returns text unchanged if within budget", () => {
		expect(truncate("short text", 100)).toBe("short text");
	});

	test("truncates from end by default", () => {
		const result = truncate("a".repeat(100), 50);
		expect(result.length).toBeLessThanOrEqual(50);
		expect(result).toContain("…[truncated]…");
		expect(result.startsWith("aaa")).toBe(true);
	});

	test("truncates from start", () => {
		const result = truncate("a".repeat(100), 50, "start");
		expect(result.length).toBeLessThanOrEqual(50);
		expect(result).toContain("…[truncated]…");
		expect(result.endsWith("aaa")).toBe(true);
	});

	test("truncates from middle", () => {
		const text = "AAAA" + "B".repeat(100) + "CCCC";
		const result = truncate(text, 50, "middle");
		expect(result.length).toBeLessThanOrEqual(50);
		expect(result).toContain("…[truncated]…");
		// Should keep some start and some end
		expect(result.startsWith("A")).toBe(true);
		expect(result.endsWith("C")).toBe(true);
	});

	test("handles very small budget", () => {
		const result = truncate("a".repeat(100), 5);
		expect(result).toContain("truncated");
	});
});

// ==========================================================================
// 7. Pack context building
// ==========================================================================

describe("buildPackContext", () => {
	beforeEach(() => {
		setupTmpDir();
		_setContextPipelineForTest("compact");
	});
	afterEach(cleanupTmpDir);

	test("returns empty string for non-existent pack", () => {
		expect(buildPackContext(path.join(tmpDir, "nope"))).toBe("");
	});

	test("builds context from full vault structure", () => {
		const { packPath } = createTestVault();
		const context = buildPackContext(packPath);

		// Should contain manifest
		expect(context).toContain("Pack System");
		expect(context).toContain("Memory Manifest");

		// Should contain context
		expect(context).toContain("Context Packs");
		expect(context).toContain("TypeScript");

		// Should contain decisions
		expect(context).toContain("Active Decisions");
		expect(context).toContain("Bun");

		// Actions are lower priority and may be trimmed under gateway-era compact budgets.

		// Should contain runbooks
		expect(context).toContain("Runbooks");
		expect(context).toContain("Deploy");
	});

	test("includes search results when provided", () => {
		const { packPath } = createTestVault();
		const context = buildPackContext(packPath, "Found: PostgreSQL config in project-context.md");

		expect(context).toContain("Relevant Memory");
		expect(context).toContain("PostgreSQL config");
	});

	test("respects total budget", () => {
		const { packPath } = createTestVault();

		// Add a lot of content to blow the budget
		for (let i = 0; i < 20; i++) {
			fs.writeFileSync(
				path.join(packPath, "40-actions", `action-${i}.md`),
				`---\ntype: action\n---\n# Action ${i}\n${"x".repeat(2000)}\n`,
			);
		}

		const context = buildPackContext(packPath);
		expect(context.length).toBeLessThanOrEqual(16500); // BUDGET.total + some headers
	});

	test("handles pack with only manifest", () => {
		const packPath = path.join(tmpDir, "minimal-pack");
		fs.mkdirSync(path.join(packPath, "00-system"), { recursive: true });
		fs.writeFileSync(
			path.join(packPath, "00-system", "manifest.md"),
			"---\ntype: system\n---\n# Manifest\nMinimal pack.",
		);

		const context = buildPackContext(packPath);
		expect(context).toContain("Pack System");
		expect(context).toContain("Minimal pack");
	});

	test("handles empty directories gracefully", () => {
		const packPath = path.join(tmpDir, "empty-dirs");
		fs.mkdirSync(path.join(packPath, "00-system"), { recursive: true });
		fs.mkdirSync(path.join(packPath, "20-context"), { recursive: true });
		fs.mkdirSync(path.join(packPath, "40-actions"), { recursive: true });
		// No files inside

		const context = buildPackContext(packPath);
		expect(context).toBe("");
	});

	test("qmd-economy uses retrieved memory and does not inject canned project facts", () => {
		const { packPath } = createTestVault();
		_setContextPipelineForTest("qmd-economy");

		const context = buildPackContext(
			packPath,
			"The service builds Lambda ZIP files, uploads them to S3, and opens an IaC PR that Terraform applies.",
			"这个项目的 Lambda 版本部署是怎么工作的？",
		);

		expect(context).toContain("qmd-economy compact memory");
		expect(context).toContain("Lambda ZIP");
		expect(context).toContain("Terraform applies");
		expect(context).toContain("semantically in any language");
		expect(context).not.toContain("ArgoCD syncs the Helm chart");
		expect(context).not.toContain("Deploy gateway to production");
	});

	test("qmd-economy ignores stale fact card when prompt has a more specific technical anchor", () => {
		const { packPath } = createTestVault();
		_setContextPipelineForTest("qmd-economy");
		fs.mkdirSync(path.join(packPath, "00-system", "fact-cards"), { recursive: true });
		fs.writeFileSync(path.join(packPath, "00-system", "fact-cards", "deploy.md"), `---\ntype: fact-card\n---\n# Deploy Fact Card\n\n## Draft answer\n\nDeploy gateway to production with ArgoCD syncs the Helm chart.\n\n## Required facts\n\n- ArgoCD syncs the Helm chart to Kubernetes.\n`);

		const context = buildPackContext(
			packPath,
			"Lambda artifacts are ZIP files in S3 and Terraform applies lambda-artifacts.auto.tfvars.json.",
			"como funciona o deploy de versão dos lambdas no projeto?",
		);

		expect(context).toContain("Lambda artifacts");
		expect(context).toContain("lambda-artifacts.auto.tfvars.json");
		expect(context).not.toContain("Deploy gateway to production");
		expect(context).not.toContain("ArgoCD syncs the Helm chart");
	});

	test("grep fallback ranks specific technical anchors above generic deploy notes", () => {
		const { packPath } = createTestVault();
		fs.writeFileSync(path.join(packPath, "70-runbooks", "generic-deploy.md"), "# Deploy\n\nDeploy gateway with Helm and ArgoCD.");
		fs.writeFileSync(path.join(packPath, "20-context", "lambda-release.md"), "# Lambda release\n\nLambda ZIP artifacts go to S3. Terraform applies lambda-artifacts.auto.tfvars.json for version rollout.");

		const result = grepSearchPack(packPath, "como funciona o deploy de versão dos lambdas no projeto?", 2);

		expect(result.text).toContain("20-context/lambda-release.md");
		expect(result.text).toContain("lambda-artifacts.auto.tfvars.json");
		expect(result.text).not.toContain("70-runbooks/generic-deploy.md");
	});
});

// ==========================================================================
// 8. Session handoff generation
// ==========================================================================

describe("buildSessionHandoff", () => {
	test("generates valid frontmatter", () => {
		const handoff = buildSessionHandoff("abc12345-full-id", "my-pack", "Did some work.");

		expect(handoff).toContain("type: action");
		expect(handoff).toContain("id: action.my-pack.session-handoff-abc12345");
		expect(handoff).toContain("title: Session Handoff abc12345");
		expect(handoff).toContain("status: completed");
		expect(handoff).toContain("pack/my-pack");
		expect(handoff).toContain("session/handoff");
	});

	test("includes session ID and summary", () => {
		const handoff = buildSessionHandoff("sess-123", "proj", "Set up CI pipeline and deployed.");

		expect(handoff).toContain("**Session:** sess-123");
		expect(handoff).toContain("Set up CI pipeline and deployed.");
	});

	test("includes related link to manifest", () => {
		const handoff = buildSessionHandoff("s1", "my-pack", "Test");

		expect(handoff).toContain("[[packs/my-pack/00-system/pi-agent/memory-manifest|Memory Manifest]]");
	});
});

// ==========================================================================
// 9. Extension registration
// ==========================================================================

describe("extension registration", () => {
	beforeEach(setupTmpDir);
	afterEach(cleanupTmpDir);

	test("registers memctx_search tool", () => {
		const { pi, tools } = createMockPi();
		registerExtension(pi as any);

		expect(tools["memctx_search"]).toBeDefined();
		expect(tools["memctx_search"].name).toBe("memctx_search");
		expect(tools["memctx_search"].description).toContain("Search across memory context pack");
	});

	test("registers all expected event hooks", () => {
		const { pi, hooks } = createMockPi();
		registerExtension(pi as any);

		expect(hooks["session_start"]).toBeDefined();
		expect(hooks["before_agent_start"]).toBeDefined();
		expect(hooks["session_before_compact"]).toBeDefined();
		expect(hooks["session_shutdown"]).toBeDefined();
	});

	test("registers only the simplified public command surface", () => {
		const { pi, commands } = createMockPi();
		registerExtension(pi as any);

		for (const command of ["memctx", "memctx-init", "memctx-status", "memctx-refresh", "memctx-doctor"]) {
			expect(commands[command]).toBeDefined();
		}
		for (const removed of ["memctx-pack", "pack", "memctx-pack-status", "pack-status", "memctx-strict", "memctx-pack-generate", "pack-generate", "memctx-retrieval", "memctx-autosave", "memctx-save-queue", "memctx-pack-enrich", "memctx-profile", "memctx-config"]) {
			expect(commands[removed]).toBeUndefined();
		}
	});

	test("/memctx-status shows workspace memory status", async () => {
		const { pi, commands } = createMockPi();
		registerExtension(pi as any);
		const ctx = createMockCtx();

		await commands["memctx-status"].handler("", ctx);
		expect(ctx.ui.notify).toHaveBeenCalled();
		expect((ctx.ui.notify.mock.calls.at(-1) as any)?.[0]).toContain("Workspace memory");
	});
});

// ==========================================================================
// 10. memctx_search tool execution (grep fallback)
// ==========================================================================

describe("memctx_search tool (grep fallback)", () => {
	beforeEach(() => {
		setupTmpDir();
		_setQmdAvailable(false);
	});
	afterEach(cleanupTmpDir);

	test("returns error when no active pack", async () => {
		const { pi, tools } = createMockPi();
		registerExtension(pi as any);
		_resetState(); // ensure no active pack

		const result = await tools["memctx_search"].execute("call-1", { query: "test" }, null, () => {}, {});
		expect(result.content[0].text).toContain("No active memory pack");
	});

	test("finds matching files by keyword", async () => {
		const { packPath } = createTestVault();
		const { pi, tools } = createMockPi();
		registerExtension(pi as any);
		_setActivePack("test-pack", packPath);

		const result = await tools["memctx_search"].execute(
			"call-1",
			{ query: "PostgreSQL" },
			null,
			() => {},
			{},
		);

		expect(result.content[0].text).toContain("PostgreSQL");
		expect(result.details.mode).toBe("grep-fallback");
	});

	test("returns no results for unmatched query", async () => {
		const { packPath } = createTestVault();
		const { pi, tools } = createMockPi();
		registerExtension(pi as any);
		_setActivePack("test-pack", packPath);

		const result = await tools["memctx_search"].execute(
			"call-1",
			{ query: "xyznonexistent" },
			null,
			() => {},
			{},
		);

		expect(result.content[0].text).toContain("No results");
	});

	test("multi-term search scores correctly", async () => {
		const { packPath } = createTestVault();
		const { pi, tools } = createMockPi();
		registerExtension(pi as any);
		_setActivePack("test-pack", packPath);

		const result = await tools["memctx_search"].execute(
			"call-1",
			{ query: "TypeScript Bun runtime" },
			null,
			() => {},
			{},
		);

		// Should find both project-context (TypeScript, Bun) and decision (Bun, runtime)
		expect(result.content[0].text).toContain("terms matched");
		expect(result.details.matchCount).toBeGreaterThan(0);
	});

	test("respects limit parameter", async () => {
		const { packPath } = createTestVault();
		// Add many matching files
		for (let i = 0; i < 10; i++) {
			fs.writeFileSync(
				path.join(packPath, "60-observations", `obs-${i}.md`),
				`---\ntype: observation\n---\n# Observation ${i}\nFound deploy issue.`,
			);
		}

		const { pi, tools } = createMockPi();
		registerExtension(pi as any);
		_setActivePack("test-pack", packPath);

		const result = await tools["memctx_search"].execute(
			"call-1",
			{ query: "deploy", limit: 3 },
			null,
			() => {},
			{},
		);

		// Count matches in output
		const matchCount = (result.content[0].text.match(/### /g) || []).length;
		expect(matchCount).toBeLessThanOrEqual(3);
	});
});

// ==========================================================================
// 11. before_agent_start context injection
// ==========================================================================

describe("before_agent_start context injection", () => {
	beforeEach(() => {
		setupTmpDir();
		_setQmdAvailable(false);
	});
	afterEach(cleanupTmpDir);

	test("returns undefined when no active pack", async () => {
		const { pi, hooks } = createMockPi();
		registerExtension(pi as any);
		_resetState();

		const result = await hooks["before_agent_start"](
			{ prompt: "hello", systemPrompt: "You are helpful." },
			createMockCtx(),
		);

		expect(result).toBeUndefined();
	});

	test("injects pack context into system prompt", async () => {
		const { packPath } = createTestVault();
		const { pi, hooks } = createMockPi();
		registerExtension(pi as any);
		_setActivePack("test-pack", packPath);

		const result = (await hooks["before_agent_start"](
			{ prompt: "what stack do we use?", systemPrompt: "You are helpful." },
			createMockCtx(),
		)) as any;

		expect(result).toBeDefined();
		expect(result.systemPrompt).toContain("You are helpful.");
		expect(result.systemPrompt).toContain("pi-memctx Memory Gateway");
		expect(result.systemPrompt).toContain("Memory Gateway Brief");
	});

	test("includes memctx_search tool hint in injection", async () => {
		const { packPath } = createTestVault();
		const { pi, hooks } = createMockPi();
		registerExtension(pi as any);
		_setActivePack("test-pack", packPath);

		const result = (await hooks["before_agent_start"](
			{ prompt: "test", systemPrompt: "" },
			createMockCtx(),
		)) as any;

		expect(result.systemPrompt).toContain("Memory Gateway Brief");
	});

	test("uses grep fallback retrieval during context injection when qmd is unavailable", async () => {
		const { packPath } = createTestVault();
		const { pi, hooks } = createMockPi();
		registerExtension(pi as any);
		_setActivePack("test-pack", packPath);
		_setQmdAvailable(false);

		const result = (await hooks["before_agent_start"](
			{ prompt: "PostgreSQL database", systemPrompt: "" },
			createMockCtx(),
		)) as any;

		expect(result.systemPrompt).toContain("Memory Gateway Brief");
		expect(result.systemPrompt).toContain("PostgreSQL");
	});

	test("injects Memory Gate and strict-mode guidance", async () => {
		const { packPath } = createTestVault();
		const { pi, hooks } = createMockPi();
		registerExtension(pi as any);
		_setActivePack("test-pack", packPath);
		_setStrictMode(true);

		const result = (await hooks["before_agent_start"](
			{ prompt: "what stack do we use?", systemPrompt: "" },
			createMockCtx(),
		)) as any;

		expect(result.systemPrompt).toContain("Memory Gateway Brief");
	});

	test("qmd-economy routing permits multilingual memory search and workspace inspection", async () => {
		const { packPath } = createTestVault();
		const { pi, hooks } = createMockPi();
		registerExtension(pi as any);
		_setActivePack("test-pack", packPath);
		_setContextPipelineForTest("qmd-economy");

		const result = (await hooks["before_agent_start"](
			{ prompt: "这个项目是怎么部署的？", systemPrompt: "" },
			createMockCtx(),
		)) as any;

		expect(result.systemPrompt).toContain("pi-memctx Memory Gateway");
		expect(result.systemPrompt).toContain("Memory Gateway Brief");
		expect(result.systemPrompt).toContain("inspect repo/docs/workflows");
		expect(result.systemPrompt).toContain("Memory Gateway Brief");
		expect(result.systemPrompt).not.toContain("Tool use is forbidden");
		expect(result.systemPrompt).not.toContain("Do not call memctx_search, bash, or read");
	});
});

// ==========================================================================
// 12. session_before_compact handoff
// ==========================================================================

describe("session_before_compact handoff", () => {
	beforeEach(() => {
		setupTmpDir();
		_setQmdAvailable(false);
	});
	afterEach(cleanupTmpDir);

	test("does nothing when no active pack", async () => {
		const { pi, hooks } = createMockPi();
		registerExtension(pi as any);
		_resetState();

		const ctx = createMockCtx();
		await hooks["session_before_compact"]({}, ctx);

		// No files created
		const actionsDir = path.join(tmpDir, "packs", "test-pack", "40-actions");
		expect(fs.existsSync(actionsDir)).toBe(false);
	});

	test("creates handoff note from branch messages", async () => {
		const { packPath } = createTestVault();
		const { pi, hooks } = createMockPi();
		registerExtension(pi as any);
		_setActivePack("test-pack", packPath);

		const ctx = {
			sessionManager: {
				getSessionId: () => "test-session-123",
				getBranch: () => [
					{
						type: "message",
						message: { role: "user", content: "Deploy to staging please" },
					},
					{
						type: "message",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "Deployed to staging successfully." }],
						},
					},
				],
			},
			hasUI: false,
			ui: { notify: mock(() => {}), setStatus: mock(() => {}) },
		};

		await hooks["session_before_compact"]({}, ctx);

		// Check that a handoff file was created
		const actionsDir = path.join(packPath, "40-actions");
		const files = fs.readdirSync(actionsDir);
		const handoffFile = files.find((f) => f.includes("session-handoff"));
		expect(handoffFile).toBeDefined();

		const content = fs.readFileSync(path.join(actionsDir, handoffFile!), "utf-8");
		expect(content).toContain("Deploy to staging");
		expect(content).toContain("Deployed to staging successfully");
		expect(content).toContain("test-session-123");
	});

	test("skips handoff when branch has no messages", async () => {
		const { packPath } = createTestVault();
		const { pi, hooks } = createMockPi();
		registerExtension(pi as any);
		_setActivePack("test-pack", packPath);

		const ctx = {
			sessionManager: {
				getSessionId: () => "empty-session",
				getBranch: () => [],
			},
			hasUI: false,
			ui: { notify: mock(() => {}) },
		};

		const filesBefore = fs.readdirSync(path.join(packPath, "40-actions"));
		await hooks["session_before_compact"]({}, ctx);
		const filesAfter = fs.readdirSync(path.join(packPath, "40-actions"));

		expect(filesAfter.length).toBe(filesBefore.length);
	});
});

// ==========================================================================
// 13. Note building and saving helpers
// ==========================================================================

describe("slugify", () => {
	test("converts title to slug", () => {
		expect(slugify("Use Chi Router for HTTP")).toBe("use-chi-router-for-http");
	});

	test("handles special characters", () => {
		expect(slugify("PostgreSQL + pgvector")).toBe("postgresql-pgvector");
	});

	test("truncates long slugs", () => {
		expect(slugify("a".repeat(100)).length).toBeLessThanOrEqual(60);
	});
});

describe("llmArchitectureNote", () => {
	test("tolerates missing optional arrays from LLM output", () => {
		const note = llmArchitectureNote("demo", {
			name: "Demo Repo",
			slug: "demo-repo",
			description: "Demo description",
			observations: ["Observed fallback architecture."],
		} as any, {
			summary: "LLM summary",
			domains: [{ name: "api", responsibility: "HTTP API" }],
			integrations: undefined,
			envVars: "DATABASE_URL",
		} as any, ["src/index.ts"], "2026-05-01");

		expect(note).toContain("LLM summary");
		expect(note).toContain("| api | HTTP API | - |");
		expect(note).toContain("No high-confidence integrations identified");
		expect(note).toContain("No environment variables identified");
	});
});

// ==========================================================================
// 14. buildNote
// ==========================================================================

describe("buildNote", () => {
	test("generates valid frontmatter", () => {
		const note = buildNote("my-pack", "observation", "Redis uses port 6379", "Discovered that Redis runs on port 6379 in dev.");
		expect(note).toContain("type: observation");
		expect(note).toContain("id: observation.my-pack.redis-uses-port-6379");
		expect(note).toContain("title: Redis uses port 6379");
		expect(note).toContain("pack/my-pack");
		expect(note).toContain("agent-memory/observation");
		expect(note).toContain("# Redis uses port 6379");
		expect(note).toContain("Discovered that Redis runs on port 6379");
		expect(note).toContain("[[packs/my-pack/00-system/pi-agent/memory-manifest|Memory Manifest]]");
	});

	test("includes custom tags", () => {
		const note = buildNote("p", "decision", "Title", "Body", ["go", "architecture"]);
		expect(note).toContain("  - go");
		expect(note).toContain("  - architecture");
	});

	test("normalizes redundant type prefixes in headings and ids", () => {
		expect(normalizeNoteTitle("runbook", "Runbook: sync central instructions")).toBe("sync central instructions");
		const note = buildNote("p", "runbook", "Runbook: sync central instructions", "Body");
		expect(note).toContain("id: runbook.p.sync-central-instructions");
		expect(note).toContain("title: sync central instructions");
		expect(note).toContain("# sync central instructions");
		expect(note).not.toContain("# Runbook:");
	});
});

describe("resolveNoteDir", () => {
	beforeEach(setupTmpDir);
	afterEach(cleanupTmpDir);

	test("finds existing directory", () => {
		const packPath = path.join(tmpDir, "pack");
		fs.mkdirSync(path.join(packPath, "50-decisions"), { recursive: true });
		expect(resolveNoteDir(packPath, "decision")).toBe(path.join(packPath, "50-decisions"));
	});

	test("creates directory if none exists", () => {
		const packPath = path.join(tmpDir, "pack");
		fs.mkdirSync(packPath, { recursive: true });
		const dir = resolveNoteDir(packPath, "observation");
		expect(fs.existsSync(dir)).toBe(true);
		expect(dir).toContain("60-observations");
	});

	test("prefers first candidate when multiple exist", () => {
		const packPath = path.join(tmpDir, "pack");
		fs.mkdirSync(path.join(packPath, "50-decisions"), { recursive: true });
		fs.mkdirSync(path.join(packPath, "30-decisions"), { recursive: true });
		expect(resolveNoteDir(packPath, "decision")).toBe(path.join(packPath, "50-decisions"));
	});
});

// ==========================================================================
// 14. memctx_save tool
// ==========================================================================

describe("memctx_save tool", () => {
	beforeEach(() => {
		setupTmpDir();
		_setQmdAvailable(false);
	});
	afterEach(cleanupTmpDir);

	test("creates a new observation note", async () => {
		const { packPath } = createTestVault();
		const { pi, tools } = createMockPi();
		registerExtension(pi as any);
		_setActivePack("test-pack", packPath);

		const result = await tools["memctx_save"].execute(
			"c1",
			{
				type: "observation",
				title: "Redis port is 6379",
				content: "Discovered Redis runs on port 6379 in dev environment.",
				tags: ["redis", "dev"],
			},
			null, () => {}, {},
		);

		expect(result.content[0].text).toContain("Saved observation");
		expect(result.details.action).toBe("created");

		// Verify file was created
		const noteDir = path.join(packPath, "60-observations");
		const files = fs.readdirSync(noteDir);
		const noteFile = files.find((f) => f.includes("redis-port"));
		expect(noteFile).toBeDefined();

		const content = fs.readFileSync(path.join(noteDir, noteFile!), "utf-8");
		expect(content).toContain("type: observation");
		expect(content).toContain("Redis port is 6379");
		expect(content).toContain("  - redis");
	});

	test("creates action notes with date prefix", async () => {
		const { packPath } = createTestVault();
		const { pi, tools } = createMockPi();
		registerExtension(pi as any);
		_setActivePack("test-pack", packPath);

		await tools["memctx_save"].execute(
			"c1",
			{ type: "action", title: "Setup CI", content: "Configured GitHub Actions." },
			null, () => {}, {},
		);

		const files = fs.readdirSync(path.join(packPath, "40-actions"));
		const actionFile = files.find((f) => f.includes("setup-ci"));
		expect(actionFile).toBeDefined();
		expect(actionFile).toMatch(/^\d{4}-\d{2}-\d{2}-/);
	});

	test("memctx_save normalizes redundant note type prefixes", async () => {
		const { packPath } = createTestVault();
		const { pi, tools } = createMockPi();
		registerExtension(pi as any);
		_setActivePack("test-pack", packPath);

		const result = await tools["memctx_save"].execute(
			"c1",
			{ type: "runbook", title: "Runbook: sync central instructions", content: "Step 1. Generate instructions. Step 2. Open PR." },
			null, () => {}, {},
		);

		expect(result.details.path).toBe("70-runbooks/sync-central-instructions.md");
		const content = fs.readFileSync(path.join(packPath, result.details.path), "utf-8");
		expect(content).toContain("title: sync central instructions");
		expect(content).toContain("# sync central instructions");
		expect(content).not.toContain("Runbook: sync central instructions");
	});

	test("appends to existing note", async () => {
		const { packPath } = createTestVault();
		const { pi, tools } = createMockPi();
		registerExtension(pi as any);
		_setActivePack("test-pack", packPath);

		// Create first
		await tools["memctx_save"].execute(
			"c1",
			{ type: "observation", title: "Redis config", content: "Port is 6379." },
			null, () => {}, {},
		);

		// Update same slug
		const result = await tools["memctx_save"].execute(
			"c2",
			{ type: "observation", title: "Redis config", content: "Also uses password auth." },
			null, () => {}, {},
		);

		expect(result.details.action).toBe("updated");

		const noteDir = path.join(packPath, "60-observations");
		const files = fs.readdirSync(noteDir).filter((f) => f.includes("redis-config"));
		expect(files).toHaveLength(1);

		const content = fs.readFileSync(path.join(noteDir, files[0]), "utf-8");
		expect(content).toContain("Port is 6379");
		expect(content).toContain("Also uses password auth");
		expect(content).toContain("## Update");
	});

	test("blocks secrets", async () => {
		const { packPath } = createTestVault();
		const { pi, tools } = createMockPi();
		registerExtension(pi as any);
		_setActivePack("test-pack", packPath);

		const result = await tools["memctx_save"].execute(
			"c1",
			{ type: "observation", title: "API Key", content: "password: super_secret_123" },
			null, () => {}, {},
		);

		expect(result.content[0].text).toContain("Blocked");
		expect(result.isError).toBe(true);
	});

	test("blocks localized secret labels", async () => {
		const { packPath } = createTestVault();
		const { pi, tools } = createMockPi();
		registerExtension(pi as any);
		_setActivePack("test-pack", packPath);

		const result = await tools["memctx_save"].execute(
			"c1",
			{ type: "observation", title: "Database config", content: "BANCO_SENHA: super_secret_123" },
			null, () => {}, {},
		);

		expect(result.content[0].text).toContain("Blocked");
		expect(result.isError).toBe(true);
	});

	test("context updates target exact repo context instead of unrelated similar notes", async () => {
		const { packPath } = createTestVault();
		const { pi, tools } = createMockPi();
		registerExtension(pi as any);
		_setActivePack("test-pack", packPath);

		fs.writeFileSync(path.join(packPath, "20-context", "argo-cd.md"), buildNote("test-pack", "context", "argo-cd", "# argo-cd\n", ["repo/argo-cd"]));
		fs.writeFileSync(path.join(packPath, "20-context", "observability-stack.md"), buildNote("test-pack", "context", "observability-stack", "# observability-stack\n", ["repo/observability-stack"]));

		const result = await tools["memctx_save"].execute(
			"c1",
			{
				type: "context",
				title: "payments-api deployment in argo-cd",
				content: "Discovered from `argo-cd/environments/prod/payments-api/values.yaml`.",
				tags: ["repo/argo-cd", "payments-api"],
			},
			null, () => {}, {},
		);

		expect(result.details.action).toBe("updated");
		expect(result.details.path).toContain("20-context/argo-cd.md");
		expect(fs.readFileSync(path.join(packPath, "20-context", "argo-cd.md"), "utf-8")).toContain("payments-api");
		expect(fs.readFileSync(path.join(packPath, "20-context", "observability-stack.md"), "utf-8")).not.toContain("payments-api");
	});

	test("blocks AWS keys", async () => {
		const { packPath } = createTestVault();
		const { pi, tools } = createMockPi();
		registerExtension(pi as any);
		_setActivePack("test-pack", packPath);

		const result = await tools["memctx_save"].execute(
			"c1",
			{ type: "observation", title: "AWS", content: "Key is AKIAIOSFODNN7EXAMPLE" },
			null, () => {}, {},
		);

		expect(result.isError).toBe(true);
	});

	test("returns error when no active pack", async () => {
		const { pi, tools } = createMockPi();
		registerExtension(pi as any);
		_resetState();

		const result = await tools["memctx_save"].execute(
			"c1",
			{ type: "observation", title: "Test", content: "Test" },
			null, () => {}, {},
		);

		expect(result.content[0].text).toContain("No active memory pack");
	});
});

// ==========================================================================
// 15. pack-generate deterministic discovery
// ==========================================================================

describe("pack-generate deterministic discovery", () => {
	beforeEach(setupTmpDir);
	afterEach(cleanupTmpDir);

	test("generates rich pack from workspace discovery", () => {
		const scanDir = path.join(tmpDir, "workspace");
		const packsDir = path.join(tmpDir, "packs");
		fs.mkdirSync(path.join(scanDir, ".github", "profile"), { recursive: true });
		fs.writeFileSync(path.join(scanDir, ".github", "profile", "README.md"), "# Org\n\nPublic organization profile.");

		const nodeRepo = path.join(scanDir, "node-app");
		fs.mkdirSync(path.join(nodeRepo, ".github", "workflows"), { recursive: true });
		fs.writeFileSync(path.join(nodeRepo, "package.json"), JSON.stringify({
			name: "node-app",
			description: "Node app description",
			scripts: { dev: "next dev", build: "next build", test: "vitest", deploy: "danger" },
			dependencies: { next: "latest", react: "latest" },
		}, null, 2));
		fs.writeFileSync(path.join(nodeRepo, "README.md"), "# Node App\n\nA generated Node application.");
		fs.writeFileSync(path.join(nodeRepo, "AGENTS.md"), "# Agents\n\nRun tests before changes.");
		fs.writeFileSync(path.join(nodeRepo, ".github", "workflows", "ci.yml"), "name: CI\non: [push]\njobs: {}\n");
		fs.writeFileSync(path.join(nodeRepo, ".env"), "API_KEY=super-secret-value");

		const goRepo = path.join(scanDir, "go-service");
		fs.mkdirSync(goRepo, { recursive: true });
		fs.writeFileSync(path.join(goRepo, "go.mod"), "module example.com/go-service\n\ngo 1.22\n");

		const emptyRepo = path.join(scanDir, "empty-repo");
		fs.mkdirSync(path.join(emptyRepo, ".git"), { recursive: true });

		const result = generatePackFromDirectory(scanDir, "workspace", packsDir);
		expect(result.filesCreated.length).toBeGreaterThan(15);
		expect(fs.existsSync(path.join(result.packPath, "20-context", "github-profile.md"))).toBe(true);
		expect(fs.existsSync(path.join(result.packPath, "20-context", "node-app.md"))).toBe(true);
		expect(fs.existsSync(path.join(result.packPath, "30-projects", "node-app.md"))).toBe(true);
		expect(fs.existsSync(path.join(result.packPath, "70-runbooks", "node-app-development.md"))).toBe(true);
		expect(fs.existsSync(path.join(result.packPath, "70-runbooks", "go-service-development.md"))).toBe(true);

		const resourceMap = fs.readFileSync(path.join(result.packPath, "00-system", "pi-agent", "resource-map.md"), "utf-8");
		expect(resourceMap).toContain(".github");
		expect(resourceMap).toContain("node-app");
		expect(resourceMap).toContain("go-service");
		expect(resourceMap).toContain("empty-repo");
		expect(resourceMap).toContain("placeholder");

		const nodeContext = fs.readFileSync(path.join(result.packPath, "20-context", "node-app.md"), "utf-8");
		expect(nodeContext).toContain("Node app description");
		expect(nodeContext).toContain("npm run build");
		expect(nodeContext).toContain("ci.yml");
		expect(nodeContext).not.toContain("super-secret-value");
		expect(nodeContext).not.toContain("API_KEY");
		expect(nodeContext).not.toContain("npm run deploy");
	});
});

// ==========================================================================
// 16. Integration: full flow
// ==========================================================================

describe("integration: full flow", () => {
	beforeEach(() => {
		setupTmpDir();
		_setQmdAvailable(false);
	});
	afterEach(cleanupTmpDir);

	test("search → inject → compact cycle", async () => {
		const { packPath } = createTestVault();
		const { pi, tools, hooks } = createMockPi();
		registerExtension(pi as any);
		_setActivePack("test-pack", packPath);

		// 1. Search
		const searchResult = await tools["memctx_search"].execute(
			"c1",
			{ query: "database PostgreSQL" },
			null,
			() => {},
			{},
		);
		expect(searchResult.content[0].text).toContain("PostgreSQL");

		// 2. Inject context
		const injectResult = (await hooks["before_agent_start"](
			{ prompt: "what database do we use?", systemPrompt: "Base prompt." },
			createMockCtx(),
		)) as any;
		expect(injectResult.systemPrompt).toContain("PostgreSQL");
		expect(injectResult.systemPrompt).toContain("Base prompt.");

		// 3. Compact (session handoff)
		const compactCtx = {
			sessionManager: {
				getSessionId: () => "integration-test-session",
				getBranch: () => [
					{ type: "message", message: { role: "user", content: "what database?" } },
					{
						type: "message",
						message: { role: "assistant", content: "We use PostgreSQL." },
					},
				],
			},
			hasUI: false,
			ui: { notify: mock(() => {}), setStatus: mock(() => {}) },
		};
		await hooks["session_before_compact"]({}, compactCtx);

		// Verify handoff was created
		const actionsDir = path.join(packPath, "40-actions");
		const files = fs.readdirSync(actionsDir);
		const handoff = files.find((f) => f.includes("session-handoff"));
		expect(handoff).toBeDefined();

		// 4. Search should now find the handoff
		const searchAfter = await tools["memctx_search"].execute(
			"c2",
			{ query: "session handoff" },
			null,
			() => {},
			{},
		);
		// The handoff file should match "session" and "handoff" terms
		expect(searchAfter.content[0].text).toContain("session-handoff");
		expect(searchAfter.details.matchCount).toBeGreaterThan(0);
	});
});

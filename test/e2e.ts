/**
 * E2E test — simulates Pi loading pi-memctx against a generated demo pack.
 *
 * Run: bun run test:e2e
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	_resetState,
	_setActivePack,
	_setQmdAvailable,
	_setVaultRoot,
	buildPackContext,
	detectActivePack,
	findVaultRoot,
	scanPackFiles,
} from "../index.js";
import registerExtension from "../index.js";

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memctx-e2e-"));
const PACKS_DIR = path.join(TMP_ROOT, "packs");
const PACK_NAME = "demo";
const PACK_PATH = path.join(PACKS_DIR, PACK_NAME);

function write(rel: string, content: string) {
	const file = path.join(PACK_PATH, rel);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, "utf-8");
}

function createDemoPack() {
	fs.writeFileSync(path.join(TMP_ROOT, "package.json"), JSON.stringify({ name: "pi-memctx" }));
	write("00-system/pi-agent/memory-manifest.md", "# Demo Memory Manifest\n\nUse this pack for the demo service.\n");
	write("00-system/indexes/context-index.md", "# Context Index\n\n| Note | Use |\n|---|---|\n| [[packs/demo/20-context/context-pack|Context]] | Demo context |\n");
	write("20-context/context-pack.md", "# Demo Context\n\nThe demo service uses Go 1.25, PostgreSQL, Redis, and GitHub Actions.\n");
	write("40-actions/2026-04-30-ci-setup.md", "# Action — CI setup\n\nGitHub Actions validates tests before release.\n");
	write("50-decisions/0001-api-style.md", "# Decision — API style\n\nUse REST handlers with clear request validation and idempotent webhook processing. Authentication uses ORY Kratos.\n");
	write("70-runbooks/deploy.md", "# Deploy Runbook\n\nDeploy production with `make deploy-prod` after tests pass. Roll back with `make rollback-prod`.\n");
}

function createMockPi() {
	const tools: Record<string, any> = {};
	const hooks: Record<string, (...args: any[]) => unknown> = {};
	const commands: Record<string, any> = {};
	return {
		pi: {
			registerTool(def: any) { tools[def.name] = def; },
			on(event: string, handler: (...args: any[]) => unknown) { hooks[event] = handler; },
			registerCommand(name: string, def: any) { commands[name] = def; },
		},
		tools,
		hooks,
		commands,
	};
}

function pass(name: string) {
	console.log(`  ✅ ${name}`);
}

function fail(name: string, detail: string) {
	console.error(`  ❌ ${name}: ${detail}`);
	process.exitCode = 1;
}

function assert(condition: boolean, name: string, detail = "") {
	if (condition) pass(name);
	else fail(name, detail || "assertion failed");
}

async function main() {
	createDemoPack();

	console.log("\n🧪 pi-memctx — E2E Test\n");
	console.log(`Vault root: ${TMP_ROOT}`);
	console.log(`Pack: ${PACK_NAME} (${PACK_PATH})\n`);

	console.log("── 1. Vault Discovery ──");
	const foundRoot = findVaultRoot(PACK_PATH);
	assert(foundRoot === TMP_ROOT, "findVaultRoot finds generated package root", `got: ${foundRoot}`);

	const foundPack = detectActivePack(PACKS_DIR);
	assert(foundPack === PACK_NAME, `detectActivePack finds generated pack (got: ${foundPack})`);

	const packFiles = scanPackFiles(PACK_PATH);
	assert(packFiles.length >= 5, `scanPackFiles finds ${packFiles.length} markdown files (≥5 expected)`);

	console.log("\n── 2. Pack Context Building ──");
	const context = buildPackContext(PACK_PATH);
	assert(context.includes("Demo Memory Manifest"), "Context includes manifest");
	assert(context.includes("Go 1.25"), "Context includes stack info");
	assert(context.includes("PostgreSQL"), "Context includes database info");
	assert(context.includes("ORY Kratos"), "Context includes decision info");
	assert(context.includes("Deploy Runbook"), "Context includes runbook");
	assert(context.length <= 16500, `Context within budget (${context.length} chars ≤ 16500)`);

	const contextWithSearch = buildPackContext(PACK_PATH, "Found: PostgreSQL deploy runbook");
	assert(contextWithSearch.includes("Relevant Memory"), "Context with search includes search header");
	assert(contextWithSearch.includes("PostgreSQL deploy"), "Context with search includes search result text");

	console.log("\n── 3. Extension Registration ──");
	_resetState();
	const { pi, tools, hooks, commands } = createMockPi();
	registerExtension(pi as any);

	assert(!!tools.memctx_search, "memctx_search tool registered");
	assert(!!tools.memctx_save, "memctx_save tool registered");
	assert(!!commands["memctx-pack"], "/memctx-pack command registered");
	assert(!!commands.pack, "/pack deprecated alias registered");
	assert(!!commands["memctx-pack-generate"], "/memctx-pack-generate command registered");
	assert(!!commands["pack-generate"], "/pack-generate deprecated alias registered");
	assert(!!commands["memctx-retrieval"], "/memctx-retrieval command registered");
	assert(!!commands["memctx-autosave"], "/memctx-autosave command registered");
	assert(!!commands["memctx-save-queue"], "/memctx-save-queue command registered");
	assert(!!commands["memctx-doctor"], "/memctx-doctor command registered");
	assert(!!commands["memctx-pack-enrich"], "/memctx-pack-enrich command registered");
	assert(!!commands["memctx-profile"], "/memctx-profile command registered");
	assert(!!commands["memctx-config"], "/memctx-config command registered");
	assert(!!hooks.session_start, "session_start hook registered");
	assert(!!hooks.before_agent_start, "before_agent_start hook registered");
	assert(!!hooks.session_before_compact, "session_before_compact hook registered");
	assert(!!hooks.session_shutdown, "session_shutdown hook registered");

	console.log("\n── 4. Context Injection ──");
	_setVaultRoot(TMP_ROOT);
	_setActivePack(PACK_NAME, PACK_PATH);
	_setQmdAvailable(false);

	const { pi: pi2, tools: tools2, hooks: hooks2 } = createMockPi();
	registerExtension(pi2 as any);
	_setVaultRoot(TMP_ROOT);
	_setActivePack(PACK_NAME, PACK_PATH);
	_setQmdAvailable(false);

	const basePrompt = "You are a helpful coding assistant.";
	const injectionResult = await hooks2.before_agent_start(
		{ prompt: "how do we deploy to production?", systemPrompt: basePrompt },
		{ sessionManager: { getSessionId: () => "e2e-test" }, hasUI: false, ui: {} },
	) as any;

	assert(!!injectionResult, "before_agent_start returns injection result");
	assert(injectionResult.systemPrompt.startsWith(basePrompt), "Preserves original system prompt");
	assert(injectionResult.systemPrompt.includes("Memory Context"), "Injects memctx header");
	assert(injectionResult.systemPrompt.includes(PACK_NAME), "Injects active pack name");
	assert(injectionResult.systemPrompt.includes("Deploy Runbook"), "Injects relevant runbook");
	assert(injectionResult.systemPrompt.includes("memctx_search"), "Hints about memctx_search tool");

	console.log("\n── 5. memctx_search Tool ──");
	const searchDb = await tools2.memctx_search.execute(
		"e2e-1", { query: "PostgreSQL database" }, null, () => {}, {},
	);
	assert(searchDb.content[0].text.includes("PostgreSQL"), "Search finds database context");
	assert(searchDb.details.mode === "grep-fallback", "Uses grep fallback when qmd is unavailable");

	const searchDeploy = await tools2.memctx_search.execute(
		"e2e-2", { query: "deploy production" }, null, () => {}, {},
	);
	assert(searchDeploy.content[0].text.includes("Deploy") || searchDeploy.content[0].text.includes("deploy"), "Search finds deploy context");

	const searchNone = await tools2.memctx_search.execute(
		"e2e-3", { query: "xyznonexistentterm" }, null, () => {}, {},
	);
	assert(searchNone.content[0].text.includes("No results"), "Search for nonexistent term returns no results");

	console.log("\n── 6. memctx_save Tool ──");
	const saveResult = await tools2.memctx_save.execute(
		"e2e-4",
		{
			type: "decision",
			title: "Use deterministic e2e packs",
			content: "E2E tests should generate temporary memory packs instead of depending on local files.",
			tags: ["testing"],
		},
		null,
		() => {},
		{},
	);
	assert(saveResult.content[0].text.includes("Saved decision"), "memctx_save creates decision note");
	assert(fs.existsSync(path.join(PACK_PATH, "50-decisions", "use-deterministic-e2e-packs.md")), "Saved decision file exists");

	const blockedSave = await tools2.memctx_save.execute(
		"e2e-5",
		{ type: "observation", title: "Bad secret", content: "api_key = abc123", tags: [] },
		null,
		() => {},
		{},
	);
	assert(blockedSave.isError === true, "memctx_save blocks secret-looking content");

	console.log("\n── 7. Session Handoff ──");
	const actionsDir = path.join(PACK_PATH, "40-actions");
	const filesBefore = fs.readdirSync(actionsDir);
	await hooks2.session_before_compact({}, {
		sessionManager: {
			getSessionId: () => "e2e-handoff-session-12345678",
			getBranch: () => [
				{ type: "message", message: { role: "user", content: "How do I deploy to staging?" } },
				{ type: "message", message: { role: "assistant", content: "Run deploy staging and use rollback if needed." } },
			],
		},
		hasUI: false,
		ui: { notify: () => {}, setStatus: () => {} },
	});
	const filesAfter = fs.readdirSync(actionsDir);
	const newFiles = filesAfter.filter((f) => !filesBefore.includes(f));
	assert(newFiles.length === 1, `Created 1 handoff file (got ${newFiles.length})`);
	const handoffContent = fs.readFileSync(path.join(actionsDir, newFiles[0]), "utf-8");
	assert(handoffContent.includes("session/handoff"), "Handoff has session/handoff tag");
	assert(handoffContent.includes("deploy to staging"), "Handoff captures conversation content");

	console.log("\n══════════════════════════════════════");
	if (process.exitCode) console.log("❌ Some tests FAILED. See above.");
	else console.log("✅ All E2E tests PASSED.");
	console.log("══════════════════════════════════════\n");

	_resetState();
	fs.rmSync(TMP_ROOT, { recursive: true, force: true });
}

main().catch((err) => {
	console.error("Fatal:", err);
	try {
		fs.rmSync(TMP_ROOT, { recursive: true, force: true });
	} catch {
		// ignore cleanup errors
	}
	process.exit(1);
});

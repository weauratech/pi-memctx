# Pack generation

`/memctx-pack-generate` creates a memory pack from a directory of repositories.

```txt
/memctx-pack-generate /path/to/repos my-project
```

`/pack-generate` remains available as a deprecated compatibility alias.

If no path is provided, pi-memctx scans the current working directory. If no slug is provided, it derives one from the scanned directory name.

## Hybrid discovery and LLM enrichment

The generator first performs deterministic local discovery so pack structure is always created even when no model is available. When `MEMCTX_LLM_MODE` is `assist` or `first` and a Pi model is selected, `/memctx-pack-generate` then runs token-conscious LLM enrichment.

The local deterministic pass detects:

- normal top-level repositories;
- hidden repository allowlist entries such as `.github` and `.gitlab`;
- Git remotes and current branch when available;
- Node/TypeScript projects from `package.json` and lockfiles;
- Go projects from `go.mod`;
- infrastructure/config hints such as Docker, Terraform, Helm, Kubernetes, `infra/`, and CI workflows;
- read-first docs such as `AGENTS.md`, `CLAUDE.md`, `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, and selected `docs/**/*.md` files;
- safe development commands from package scripts, Go manifests, and Make targets.

## LLM-assisted deep enrichment

When LLM enrichment is enabled, pi-memctx:

1. builds a compact file inventory per active repository;
2. asks the selected model to choose the highest-value files for architecture/API/data-model/integration understanding;
3. extracts redacted snippets only from those selected files;
4. asks the model to synthesize compact JSON;
5. writes evidence-based architecture notes such as `20-context/<repo>-llm-architecture.md`;
6. appends those notes to `00-system/indexes/context-index.md`.

Token controls:

- file inventory is metadata-first;
- selected files are capped;
- snippets are truncated;
- sensitive filenames are skipped;
- high-confidence secret-looking values are redacted before model use.

Disable LLM use with:

```bash
MEMCTX_LLM_MODE=off
```

Prefer stronger LLM usage with:

```bash
MEMCTX_LLM_MODE=first
```

## Generated structure

The generated pack uses the full memory-pack layout:

```txt
00-system/pi-agent/memory-manifest.md
00-system/pi-agent/retrieval-protocol.md
00-system/pi-agent/resource-map.md
00-system/indexes/*.md
10-user/
20-context/overview.md
20-context/<repo>.md
20-context/<repo>-llm-architecture.md   # when LLM enrichment runs
30-projects/<repo>.md
40-actions/
50-decisions/
60-observations/workspace-repository-map.md
70-runbooks/<repo>-development.md
80-sessions/
```

Runbooks are generated only when safe setup/check commands are inferred. Deploy, production, release, publish, destructive, and credential-related commands are excluded from generated runbooks.

## Safety and redaction

The generator skips sensitive file names such as `.env`, private keys, credential files, and secret files. It also redacts high-confidence secret-looking values before writing notes.

Generated notes are context, not authority. Source-of-truth repository files, tests, CI, and live runtime facts override memory.

## Enriching an existing pack

Use `/memctx-pack-enrich [source-dir]` to rerun deterministic repository inventory and optional LLM-assisted enrichment for the active pack without regenerating the entire pack. The command runs in the background so the Pi terminal remains responsive. If `source-dir` is omitted, pi-memctx tries the source directory recorded in the pack resource map.

Use `/memctx-pack-generate --deep` to opt into LLM-assisted deep enrichment during pack generation when a model is selected. Without `--deep`, generation still writes deterministic repository context, source inventory, stack signals, and safe source-of-truth pointers.

## Current limitations

LLM enrichment is intentionally evidence-bounded: it summarizes selected redacted snippets and should not be treated as source of truth. If no model is selected or no API key is available, `/memctx-pack-generate` still produces the deterministic pack and skips LLM enrichment with a warning.

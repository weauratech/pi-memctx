# Pack generation

`/pack-generate` creates a memory pack from a directory of repositories.

```txt
/pack-generate /path/to/repos my-project
```

If no path is provided, pi-memctx scans the current working directory. If no slug is provided, it derives one from the scanned directory name.

## Deterministic discovery

The generator performs local-only discovery and writes a structured pack before any future LLM enrichment step. It detects:

- normal top-level repositories;
- hidden repository allowlist entries such as `.github` and `.gitlab`;
- Git remotes and current branch when available;
- Node/TypeScript projects from `package.json` and lockfiles;
- Go projects from `go.mod`;
- infrastructure/config hints such as Docker, Terraform, Helm, Kubernetes, `infra/`, and CI workflows;
- read-first docs such as `AGENTS.md`, `CLAUDE.md`, `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, and selected `docs/**/*.md` files;
- safe development commands from package scripts, Go manifests, and Make targets.

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

## Current limitation

This phase is deterministic. LLM-assisted synthesis and `/pack-enrich` are planned as follow-up phases so generated notes can be further summarized without overwriting human-authored memory.

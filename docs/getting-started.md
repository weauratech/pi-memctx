# Getting Started

pi-memctx is a Pi extension that loads local Markdown memory packs, injects relevant context before the agent acts, and exposes tools for search and safe persistence.

## Install

```bash
pi install git:github.com/weauratech/pi-memctx
```

Restart Pi or run `/reload` if your Pi session supports it.

## Pack locations

pi-memctx looks for packs in this order:

1. `MEMCTX_PACKS_PATH`
2. `<cwd>/.pi/memory-vault/packs/`
3. `~/.pi/agent/memory-vault/packs/`

## Create a pack

Use `/memctx-pack-generate` inside a Pi session:

```txt
/memctx-pack-generate /path/to/repos my-project
```

The generator performs deterministic local discovery of repositories, read-first docs, package scripts, GitHub Actions, Git remotes, Go/Node manifests, safe development commands, and selected infrastructure hints. When `MEMCTX_LLM_MODE` is enabled and a model is selected, it also performs LLM-assisted deep enrichment from selected redacted source snippets. See [Pack generation](pack-generate.md).

Or create folders manually:

```txt
packs/my-project/
  00-system/
  20-context/
  40-actions/
  50-decisions/
  60-observations/
  70-runbooks/
  80-sessions/
```

See `examples/basic-pack/` for a minimal public-safe pack.

## Use a pack

```txt
/memctx-pack
/memctx-pack my-project
/memctx-pack-status
```

Deprecated aliases remain available for compatibility: `/pack`, `/pack-status`, and `/pack-generate`.

Strict mode is on by default for stronger retrieval guidance before project-specific answers. You can toggle it when needed:

```txt
/memctx-strict on
/memctx-strict off
```

Configure automatic pack switching and LLM assistance:

```txt
/memctx-auto-switch all
/memctx-llm first
```

Environment equivalents:

```bash
MEMCTX_AUTO_SWITCH=off|cwd|prompt|all
MEMCTX_LLM_MODE=off|assist|first
MEMCTX_RETRIEVAL=auto|fast|balanced|deep|strict
MEMCTX_AUTOSAVE=off|suggest|confirm|auto
```

Use stronger retrieval and memory capture when desired:

```txt
/memctx-retrieval strict
/memctx-autosave suggest
/memctx-save-queue
/memctx-doctor
```

Ask the agent to search memory:

```txt
Use memctx_search to find the deploy runbook.
```

pi-memctx also retrieves prompt-relevant memory automatically before each turn. It uses qmd when available and grep fallback otherwise.

Ask the agent to save durable memory:

```txt
Save this as a decision: we use deterministic e2e packs for integration tests.
```

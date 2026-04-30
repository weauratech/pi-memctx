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

Use `/pack-generate` inside a Pi session:

```txt
/pack-generate /path/to/repos my-project
```

The generator performs deterministic local discovery of repositories, read-first docs, package scripts, GitHub Actions, Git remotes, Go/Node manifests, safe development commands, and selected infrastructure hints. See [Pack generation](pack-generate.md).

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
/pack
/pack my-project
/pack-status
```

Use strict mode when you want stronger retrieval guidance before project-specific answers:

```txt
/memctx-strict on
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

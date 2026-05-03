# Getting Started

pi-memctx is a Pi extension that gives each workspace local Markdown memory. It injects relevant context before the agent acts and can learn durable discoveries after turns.

## Install

```bash
pi install npm:pi-memctx
```

Or install from GitHub:

```bash
pi install git:github.com/weauratech/pi-memctx
```

Restart Pi or run `/reload` if your Pi session supports it.

## Initialize workspace memory

Start Pi from your project/workspace:

```bash
cd /path/to/workspace
pi -e pi-memctx
```

Inside Pi:

```txt
/memctx-init
```

`/memctx-init` creates or updates local Markdown memory for the current workspace, writes a workspace-to-memory mapping, and starts background enrichment when a model is selected. Internally the memory is stored as a Markdown pack, but most users do not need to switch or manage packs manually.

## Daily commands

```txt
/memctx          # compact help and current status
/memctx-init     # create/update memory for this workspace
/memctx-status   # show workspace memory status
/memctx-refresh  # refresh inventory/enrichment in the background
/memctx-doctor   # diagnose setup issues
```

Add `--advanced` to `/memctx-status` when you need internal paths/config details.

## Where memory lives

pi-memctx stores workspace memory under a local memory vault. It resolves packs in this order:

1. `MEMCTX_PACKS_PATH`
2. `<cwd>/.pi/memory-vault/packs/`
3. `~/.pi/agent/memory-vault/packs/`

Workspace path mappings are stored in the vault under `00-system/workspace-map.json`, so subdirectories can resolve the same workspace memory automatically.

Example internal structure:

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

## Use memory naturally

Ask normal questions:

```txt
How do I deploy this service to production?
```

pi-memctx retrieves prompt-relevant memory automatically before each turn. It uses qmd when available and grep fallback otherwise. If memory is insufficient or stale, Pi inspects the repository normally.

The gateway profile enables conservative automatic learning by default. After detailed turns, pi-memctx may save linked context, observations, runbooks, actions, decisions, and rich session snapshots as Markdown.

## Search or save explicitly

Ask the agent to search memory:

```txt
Use memctx_search to find the deploy runbook.
```

Ask the agent to save durable memory:

```txt
Save this as a decision: we use deterministic e2e packs for integration tests.
```

## Advanced configuration

Most users should keep defaults. Advanced behavior can be controlled with environment variables or `~/.config/pi-memctx/config.json`:

```bash
MEMCTX_AUTO_SWITCH=off|cwd|prompt|all
MEMCTX_LLM_MODE=off|assist|first
MEMCTX_RETRIEVAL=auto|fast|balanced|deep|strict
MEMCTX_RETRIEVAL_LATENCY_BUDGET_MS=1000
MEMCTX_AUTOSAVE=off|suggest|confirm|auto
MEMCTX_AUTOSAVE_QUEUE_LOW_CONFIDENCE=true
```

# Workspace memory initialization

`/memctx-init` creates or updates local Markdown memory for the current workspace.

```txt
/memctx-init
/memctx-init /path/to/repos my-project
/memctx-init --no-deep
```

The command performs deterministic local discovery so memory structure is always created even when no model is available. When a Pi model is selected, deep LLM enrichment starts in the background by default. Use `--no-deep` to skip LLM enrichment.

Internally, workspace memory is stored as a Markdown pack. Most users do not need to manage packs directly.

## What gets generated

`/memctx-init` creates a pack with:

- `00-system/pi-agent/memory-manifest.md`
- `00-system/pi-agent/resource-map.md`
- `00-system/indexes/*.md`
- `20-context/<repo>.md`
- `30-projects/<repo>.md`
- `60-observations/workspace-repository-map.md`
- optional `70-runbooks/*` for safe generated development notes

It also records the workspace path in `00-system/workspace-map.json` so future sessions inside that workspace or subdirectories can resolve the correct memory automatically.

## Refreshing memory

Use `/memctx-refresh` to rerun deterministic repository inventory and optional LLM-assisted enrichment for the active workspace memory without rebuilding everything:

```txt
/memctx-refresh
/memctx-refresh /path/to/repos
/memctx-refresh --no-deep
```

The refresh runs in the background so the Pi terminal remains responsive.

## Discovery behavior

The generator looks for source-of-truth signals such as:

- Git remotes and current branch
- README/AGENTS/CLAUDE docs
- package scripts and safe development commands
- GitHub Actions workflows
- Go/Node/Java/Python/Terraform/Kubernetes/YAML/SQL files
- repository directory structure
- selected source inventory and redacted excerpts

Large files, hidden directories, dependency folders, and sensitive file names are skipped.

## LLM enrichment

When a model is selected, pi-memctx asks the model to synthesize compact architecture notes from selected redacted evidence. LLM-generated notes are context, not source of truth. Repository files still win when behavior matters.

## Safety

Generated content is sanitized before being written. Do not store secrets, credentials, tokens, customer data, or sensitive payloads in memory packs.

# pi-memctx

Automatic memory context injection for [pi coding agent](https://github.com/mariozechner/pi-mono).

Load, search, and persist knowledge across sessions using Markdown packs.

## What it does

| Feature | Mechanism | Behavior |
|---|---|---|
| **Auto-injection** | `before_agent_start` | Reads active pack → searches for relevant memories → injects prioritized context into system prompt |
| **Semantic search** | `memctx_search` tool | 3 modes via qmd (keyword/semantic/deep) + grep fallback |
| **Persist learnings** | `memctx_save` tool | Save observations, decisions, actions, runbooks, context to the pack |
| **Session handoff** | `session_before_compact` | Captures recent conversation as an action note |
| **Pack detection** | `session_start` | Auto-detects the best pack for the current working directory |
| **Pack switching** | `/pack` command | Switch packs mid-session (picker or direct) |
| **Pack generation** | `/pack-generate` command | Generate a pack from a directory of repos |

## Install

```bash
pi install git:github.com/weauratech/pi-memctx
```

## Setup

Create your packs in one of these locations (checked in order):

| Priority | Location | Use case |
|---|---|---|
| 1 | `MEMCTX_PACKS_PATH` env var | Explicit override |
| 2 | `<cwd>/.pi/memory-vault/packs/` | Project-local (share via git) |
| 3 | `~/.pi/agent/memory-vault/packs/` | Global default |

### Create a pack from a directory of repos

```bash
# Inside pi session:
/pack-generate /path/to/my-repos my-project

# Or from current directory:
/pack-generate
```

### Create a pack manually

```bash
mkdir -p ~/.pi/agent/memory-vault/packs/my-project/00-system/pi-agent
mkdir -p ~/.pi/agent/memory-vault/packs/my-project/20-context
```

Add Markdown files with frontmatter:

```markdown
---
type: context-pack
id: context.my-project.stack
title: Project Stack
status: active
tags:
  - pack/my-project
  - agent-memory/context-pack
---

# Project Stack

- Language: Go 1.25
- Database: PostgreSQL 16
- Framework: Chi router
```

## Context injection priority

When injecting pack context into the system prompt, sections are included in priority order:

| Priority | Section | Budget | Source dir |
|---|---|---|---|
| 1 (highest) | Pack manifest + indexes | 2,000 chars | `00-system/` |
| 2 | Context packs | 3,000 chars | `20-context/` |
| 3 | Search results | 2,500 chars | qmd or grep |
| 4 | Recent actions | 2,000 chars | `40-actions/` |
| 5 | Active decisions | 2,000 chars | `50-decisions/` |
| 6 (lowest) | Runbooks | 2,000 chars | `70-runbooks/` |

Total budget: **16,000 chars**. Lower-priority sections trimmed first.

## Tools

### memctx_search

Search across pack files:

```
use memctx_search to find information about deploy
```

Modes: `keyword` (fast, default), `semantic` (~2s), `deep` (~10s).
Requires [qmd](https://github.com/tobi/qmd) for semantic/deep. Falls back to grep without it.

### memctx_save

Persist learnings to the active pack:

```
save this as a decision: we chose pgx over database/sql for PostgreSQL
```

Types: `observation`, `decision`, `action`, `runbook`, `context`.

Safety: blocks secrets, tokens, API keys, private keys automatically.

## Commands

### /pack

Switch packs mid-session:

```
/pack              # interactive picker
/pack my-project   # switch directly
```

### /pack-generate

Generate a pack from a directory of repos:

```
/pack-generate /path/to/repos my-slug
```

Scans for `go.mod`, `package.json`, `README.md`, `CLAUDE.md`, `AGENTS.md` and builds context automatically.

## Auto-detect by cwd

With multiple packs, the extension picks the best one based on your working directory. It scores each pack by matching cwd path segments against pack content.

## Optional: qmd for semantic search

Install [qmd](https://github.com/tobi/qmd) for semantic search:

```bash
npm install -g @tobilu/qmd
```

Without qmd, search uses keyword grep (still works, just less smart).

## Development

```bash
npm install
bun test test/          # 80 unit tests
bun run test/e2e.ts     # e2e tests
```

## License

MIT

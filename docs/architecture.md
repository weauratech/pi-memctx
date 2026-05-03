# Architecture

pi-memctx is a single Pi extension implemented in `index.ts`.

## Runtime flow

```txt
session_start
  -> load persistent profile/config from ~/.config/pi-memctx/config.json
  -> resolve workspace memory from workspace-map.json by longest cwd prefix
  -> resolve pack directory and active internal Markdown pack
  -> resolve qmd from explicit env/local/PATH or use grep fallback
  -> optionally index with qmd

before_agent_start
  -> optionally switch memory from cwd/prompt intent
  -> apply retrieval policy (auto/fast/balanced/deep/strict)
  -> keep auto retrieval latency-bounded
  -> search active workspace memory for prompt-relevant context
  -> build compact Memory Gateway Brief
  -> append context and guidance to the system prompt

memctx_search
  -> qmd keyword/semantic/deep search when available
  -> grep-style Markdown fallback when qmd is unavailable or misses

memctx_save
  -> validate content against secret patterns
  -> normalize note titles
  -> write Markdown note with frontmatter
  -> update/index related links when appropriate

agent_end
  -> curate durable memory candidates
  -> enrich shallow candidates from detailed final answers
  -> save linked context/observation/runbook/decision/action/session notes
  -> force sanitized rich-persistence session snapshots for large detailed turns

session_before_compact
  -> write a compact handoff action note, LLM-structured when available

tool_result
  -> on tool failures, search memory for potentially relevant troubleshooting notes

/memctx-init
  -> discover repositories under the target workspace
  -> collect sanitized evidence from docs, manifests, workflows, git, and safe command sources
  -> write full internal pack structure, resource map, context notes, project notes, observations, runbooks, and indexes
  -> record workspace path -> memory mapping

/memctx-refresh
  -> rerun deterministic inventory and optional LLM synthesis in the background
```

## User-facing model

The public UX is **workspace memory**:

- `/memctx` — compact help and current status
- `/memctx-init` — create/update memory for the current workspace
- `/memctx-status` — show workspace memory status (`--advanced` reveals internal paths/config)
- `/memctx-refresh` — refresh workspace inventory/enrichment
- `/memctx-doctor` — diagnose setup issues

The internal storage model remains Markdown packs under a memory vault. Packs are useful for isolation, indexing, links, and versioning, but ordinary users should not need to switch or manage them manually.

## Design principles

- Local-first: no hosted service is required.
- Markdown-first: memory is reviewable with normal tools.
- Workspace-first UX: users initialize memory for a directory and then ask normally.
- Bounded context: lower-priority sections are trimmed before flooding the prompt.
- qmd optional: semantic search is attempted automatically when available, but grep fallback remains the hard guarantee.
- Observable memory state: `/memctx-status` reports workspace memory readiness; `/memctx-status --advanced` shows internal pack/config/search details.
- Rich persistence by default: when pi-memctx persists, notes should be reusable without the original conversation.
- Source of truth wins: repository files and live system state override memory notes.
- Generated memory is conservative: deterministic generation avoids destructive commands and redacts sensitive-looking values.

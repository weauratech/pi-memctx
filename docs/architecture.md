# Architecture

pi-memctx is a single Pi extension implemented in `index.ts`.

## Runtime flow

```txt
session_start
  -> resolve pack directory
  -> detect active pack
  -> resolve qmd from MEMCTX_QMD_BIN, PATH, or bundled optional dependency
  -> optionally index with qmd

before_agent_start
  -> optionally switch packs from prompt intent
  -> apply retrieval policy (auto/fast/balanced/deep/strict)
  -> keep auto retrieval latency-bounded (default 1000ms)
  -> optionally expand queries with LLM
  -> search active pack for prompt-relevant context with qmd when available
  -> fall back to grep-style Markdown search when qmd is unavailable or returns no result
  -> build bounded context block
  -> append context plus Memory Gate guidance to the system prompt

memctx_search
  -> qmd keyword/semantic/deep search when available
  -> grep-style Markdown fallback when qmd is unavailable or misses

memctx_save
  -> validate content against secret patterns
  -> write Markdown note with frontmatter
  -> update an index when available

agent_end
  -> optionally generate/queue autosave memory candidates

session_before_compact
  -> write a compact handoff action note, LLM-structured when available

tool_result
  -> on tool failures, search memory for potentially relevant troubleshooting notes

memctx-pack-generate
  -> discover repositories under the target directory
  -> collect sanitized evidence from docs, manifests, workflows, git, and safe command sources
  -> write full pack structure, resource map, context notes, project notes, observations, runbooks, and indexes
```

## Design principles

- Local-first: no hosted service is required.
- Markdown-first: memory is reviewable with normal tools.
- Bounded context: lower-priority sections are trimmed before flooding the prompt.
- qmd optional: semantic search is attempted automatically when available, but grep fallback remains the hard guarantee.
- Observable memory state: `/memctx-pack-status` reports active pack, qmd resolution, LLM mode, strict mode, retrieval policy, autosave mode, and last retrieval; the footer overlay includes current `memctx-strict`, `memctx-llm`, retrieval, and autosave values.
- Strict guidance defaults to on. Disable with `MEMCTX_STRICT=false` or `/memctx-strict off` when lower retrieval pressure is preferred.
- Source of truth wins: repository files and live system state override memory notes.
- Generated memory is conservative: deterministic pack generation avoids destructive commands and redacts sensitive-looking values.

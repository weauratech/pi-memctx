# Architecture

pi-memctx is a single Pi extension implemented in `index.ts`.

## Runtime flow

```txt
session_start
  -> resolve pack directory
  -> detect active pack
  -> optionally index with qmd

before_agent_start
  -> search active pack for prompt-relevant context
  -> build bounded context block
  -> append context to the system prompt

memctx_search
  -> qmd keyword/semantic/deep search when available
  -> grep-style Markdown fallback when qmd is unavailable

memctx_save
  -> validate content against secret patterns
  -> write Markdown note with frontmatter
  -> update an index when available

session_before_compact
  -> write a compact handoff action note
```

## Design principles

- Local-first: no hosted service is required.
- Markdown-first: memory is reviewable with normal tools.
- Bounded context: lower-priority sections are trimmed before flooding the prompt.
- qmd optional: semantic search is an enhancement, not a hard dependency.
- Source of truth wins: repository files and live system state override memory notes.

# Decision 0001 — Local-first memory context

## Status

Accepted.

## Context

Coding agents need durable project memory, but hosted memory services add operational overhead, privacy risk, and vendor lock-in.

## Decision

pi-memctx uses local Markdown packs as the memory source and a Pi extension as the runtime integration.

qmd may be used for semantic/deep search, but it remains optional. Without qmd, pi-memctx falls back to local keyword search.

## Consequences

- Users can inspect, edit, review, and version memory with normal tools.
- Private packs can remain outside public repositories.
- Search quality improves with qmd but baseline functionality works without it.
- Users are responsible for keeping memory packs free of secrets and stale instructions.

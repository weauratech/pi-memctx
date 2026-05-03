# Persistence and automatic learning

pi-memctx can learn durable project knowledge after a turn and save it as local Markdown.

The default `gateway` profile uses conservative automatic learning. When a completed turn contains useful durable knowledge, pi-memctx may save linked notes such as:

- `20-context/` — workspace/repository/component context
- `40-actions/` — completed work or delivered plans
- `50-decisions/` — technical decisions with rationale
- `60-observations/` — durable facts, requirements, caveats, patterns
- `70-runbooks/` — repeatable procedures
- `80-sessions/` — sanitized rich planning/discovery snapshots

## Rich persistence

When the final answer contains detailed planning, debugging, implementation, or repository-discovery content, pi-memctx enriches saved notes so future agents can reuse them without the original conversation. It also forces an `80-sessions` snapshot for large detailed turns when durable memory is saved.

Example post-turn UI:

```txt
memctx: learned 5 memories:
   - context: [[packs/my-pack/20-context/payment-api|Payment API]] (updated)
   - observation: [[packs/my-pack/60-observations/deploy-patterns|Deploy patterns]] (created)
   - runbook: [[packs/my-pack/70-runbooks/deploy-payment-api|Deploy Payment API]] (created)
   - action: [[packs/my-pack/40-actions/2026-05-02-prepared-rollout|Prepared rollout]] (created)
   - session: [[packs/my-pack/80-sessions/rich-persistence-payment-api|Rich planning snapshot]] (created)
```

Learned notes are cross-linked with `[[wikilinks]]` to improve navigation and future retrieval.

## Explicit saves

The `memctx_save` tool remains available to the agent when you explicitly ask it to remember something:

```txt
Save this as a runbook: production deploy requires the release checklist and manual approval.
```

Supported note types:

- `context`
- `observation`
- `runbook`
- `decision`
- `action`
- `session`

## Safety

pi-memctx blocks or redacts secret-looking content before persistence. Do not ask it to save:

- API keys
- tokens
- passwords
- private keys
- credentials
- customer data
- sensitive payloads

If a secret-like value appeared in a turn, pi-memctx should summarize the risk without storing the value.

## Advanced configuration

Most users should keep the default learning mode. Advanced users can set `MEMCTX_AUTOSAVE=off|suggest|confirm|auto` or edit `~/.config/pi-memctx/config.json`.

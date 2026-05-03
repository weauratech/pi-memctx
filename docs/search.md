# Search and retrieval

pi-memctx retrieves relevant workspace memory automatically before each prompt. The main user workflow is simply:

```txt
Ask Pi normally.
```

The Memory Gateway searches local Markdown notes, judges whether they are useful, injects compact context when appropriate, and lets Pi inspect the repository normally when memory is insufficient or stale.

## Search backend

pi-memctx uses qmd when available and falls back to grep when qmd is missing.

Resolution order:

1. `QMD_PATH` or `MEMCTX_QMD_BIN`
2. local/vendor binary paths
3. `qmd` on `PATH`
4. grep fallback

Check setup with:

```txt
/memctx-doctor
```

or:

```bash
npx pi-memctx doctor
```

## Explicit search

The `memctx_search` tool is available to the agent. You can ask for it explicitly:

```txt
Use memctx_search to find the deploy runbook.
```

Modes:

- `keyword` — fast lexical search
- `semantic` — meaning-based qmd search when available
- `deep` — hybrid/reranked qmd search when available

When the Memory Gateway already injected sufficient memory, the agent is instructed not to call `memctx_search` again. That keeps answers fast and avoids duplicate retrieval.

## Tuning

Most users should keep the default `gateway` profile. Advanced users can tune retrieval with environment variables or `~/.config/pi-memctx/config.json`:

```bash
MEMCTX_RETRIEVAL=auto|fast|balanced|deep|strict
MEMCTX_RETRIEVAL_LATENCY_BUDGET_MS=1000
MEMCTX_GATEWAY_JUDGE=off|conservative|auto|main-llm
```

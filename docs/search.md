# Search

`memctx_search` searches the active memory pack. Automatic context injection also performs prompt-specific retrieval before each agent turn using the configured retrieval policy.

## Tool modes

- `keyword`: fast default mode.
- `semantic`: meaning-based search when qmd is installed.
- `deep`: hybrid/reranked search when qmd is installed.

## Automatic retrieval policies

```txt
/memctx-retrieval auto|fast|balanced|deep|strict|status
```

- `auto`: default; starts with fast keyword retrieval and only attempts bounded expansion when needed.
- `fast`: one keyword query.
- `balanced`: keyword plus LLM-expanded queries when available.
- `deep`: multi-query retrieval with deeper qmd mode.
- `strict`: always attempts expanded retrieval and reports attempted queries/cross-pack hints.

`auto` uses `MEMCTX_RETRIEVAL_LATENCY_BUDGET_MS` with a default of `1000`, so strict mode no longer turns `auto` into full strict retrieval. Use `/memctx-retrieval strict` when depth matters more than latency.

qmd is resolved from `QMD_PATH`/`MEMCTX_QMD_BIN`, the optional bundled `@tobilu/qmd` dependency, local/vendor binaries, or `PATH`. Without qmd, pi-memctx falls back to local grep-style Markdown search.

## Examples

```txt
memctx_search(query="deploy rollback", mode="keyword", limit=5)
memctx_search(query="why did we choose postgres", mode="semantic", limit=5)
memctx_search(query="incident runbook for queue lag", mode="deep", limit=3)
```

## qmd

pi-memctx attempts to use qmd automatically:

1. `QMD_PATH` or `MEMCTX_QMD_BIN`
2. `@tobilu/qmd` optional dependency installed with the package
3. local `node_modules/.bin/qmd` or `vendor/qmd/<platform>-<arch>/qmd`
4. `qmd` on `PATH`
5. grep fallback

Use `/memctx-pack-status`, `/memctx-doctor`, or `npx pi-memctx doctor` to see which path is active. `/pack-status` remains available as a deprecated compatibility alias.

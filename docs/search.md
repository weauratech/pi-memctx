# Search

`memctx_search` searches the active memory pack. Automatic context injection also performs prompt-specific retrieval before each agent turn.

## Modes

- `keyword`: fast default mode.
- `semantic`: meaning-based search when qmd is installed.
- `deep`: hybrid/reranked search when qmd is installed.

qmd is resolved from `MEMCTX_QMD_BIN`, `PATH`, or the optional bundled `@tobilu/qmd` dependency. Without qmd, pi-memctx falls back to local grep-style Markdown search.

## Examples

```txt
memctx_search(query="deploy rollback", mode="keyword", limit=5)
memctx_search(query="why did we choose postgres", mode="semantic", limit=5)
memctx_search(query="incident runbook for queue lag", mode="deep", limit=3)
```

## qmd

pi-memctx attempts to use qmd automatically:

1. `MEMCTX_QMD_BIN`
2. `qmd` on `PATH`
3. `node_modules/.bin/qmd` from the optional bundled dependency
4. grep fallback

Use `/memctx-pack-status` to see which path is active. `/pack-status` remains available as a deprecated compatibility alias.

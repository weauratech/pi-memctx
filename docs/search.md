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

- `auto`: default; chooses a safe policy from strict/LLM/qmd state.
- `fast`: one keyword query.
- `balanced`: keyword plus LLM-expanded queries when available.
- `deep`: multi-query retrieval with deeper qmd mode.
- `strict`: always attempts expanded retrieval and reports attempted queries/cross-pack hints.

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

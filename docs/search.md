# Search

`memctx_search` searches the active memory pack.

## Modes

- `keyword`: fast default mode.
- `semantic`: meaning-based search when qmd is installed.
- `deep`: hybrid/reranked search when qmd is installed.

Without qmd, pi-memctx falls back to local grep-style Markdown search.

## Examples

```txt
memctx_search(query="deploy rollback", mode="keyword", limit=5)
memctx_search(query="why did we choose postgres", mode="semantic", limit=5)
memctx_search(query="incident runbook for queue lag", mode="deep", limit=3)
```

## qmd

Install qmd if you want semantic/deep search:

```bash
npm install -g @tobilu/qmd
```

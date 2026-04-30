# Benchmark

Measure the real impact of pi-memctx on agent performance.

## Quick start

```bash
# 1. Setup fake project + pack
bash benchmark/setup.sh

# 2. Run benchmark (5 tasks × 2 modes)
bash benchmark/run.sh
```

## What it measures

Each task runs twice: once without pi-memctx (baseline) and once with it.

| Metric | What it shows |
|---|---|
| **Duration** | Time to first complete response |
| **Tool calls** | How many bash/read calls the agent needed |
| **Quality score** | How many key facts the response contains |

## Tasks

| Task | Key facts expected |
|---|---|
| Deploy gateway to prod | ArgoCD, GitHub Actions, ECR, manual approval, Helm |
| Database pattern | Double-entry, immutable, integer cents, debit/credit |
| Project architecture | Hexagonal, Go 1.24, Chi, Next.js, PostgreSQL |
| Add Terraform module | modules/ dir, main.tf, terragrunt, live/ |
| Safe vs dangerous commands | plan, validate, destroy, caution |

## Expected results

With pi-memctx:
- **Fewer tool calls** — agent already has context, doesn't need to `find`/`grep`/`read`
- **Higher quality** — knows architecture decisions, conventions, runbooks
- **Faster responses** — less exploration, more direct answers

## Output

Results saved to `/tmp/pi-memctx-benchmark/results/`:
- `*_baseline.txt` — raw agent output without extension
- `*_memctx.txt` — raw agent output with extension
- `*_metrics.json` — structured metrics per task

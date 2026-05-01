# Benchmark

Measure the local impact of pi-memctx inside your own Pi CLI.

The benchmark compares the same tasks with **no extensions** (`baseline`) and with pi-memctx loaded using a profile such as `full`. It does not add extension slash commands; it runs Pi in print mode with isolated environment variables.

## Quick start

```bash
# 1. Setup fake project + pack
bash benchmark/setup.sh

# 2. Run local comparison: baseline vs profile:full
bash benchmark/run.sh
```

Optional:

```bash
BENCH_REPEATS=2 BENCH_PROFILES="baseline auto full" bash benchmark/run.sh
BENCH_PI_MODEL="github-copilot/gpt-5.5" bash benchmark/run.sh
```

## What it measures

Each task runs for each selected profile.

| Metric | What it shows |
|---|---|
| **Duration** | End-to-end print-mode task duration |
| **Observed tool calls** | Best-effort count from the raw Pi output |
| **Quality score** | How many expected key facts the response contains |
| **Approx visible tokens** | Approximation from prompt+output chars / 4 |

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

- `*_baseline_r*.txt` — raw agent output without extensions
- `*_full_r*.txt` — raw agent output with pi-memctx profile `full`
- `*_metrics.json` — structured metrics per task/profile/repeat
- `summary-<run-id>.jsonl` — machine-readable aggregate rows
- `report-<run-id>.md` — human-readable report

## Notes

- The baseline uses `--no-extensions` so globally installed pi-memctx does not leak into the baseline.
- The memctx run uses `--no-extensions -e <repo>` so only the local extension under test is loaded.
- Profile config is isolated per run with `MEMCTX_CONFIG_PATH`.
- Token counts are approximate visible tokens. Provider-side system/context/cache token usage requires provider/Pi usage instrumentation and is not included in this local script.

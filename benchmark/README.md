# Benchmark

Measure the local impact of pi-memctx inside your own Pi CLI.

The benchmark compares the same tasks with **no extensions** (`baseline`) and with pi-memctx loaded using the single recommended `gateway` profile. It runs Pi in print mode with isolated environment variables.

## Quick start

```bash
# 1. Setup fake project + pack
bash benchmark/setup.sh

# 2. Run local comparison: baseline vs gateway
bash benchmark/run.sh
```

Optional:

```bash
BENCH_REPEATS=2 BENCH_PROFILES="baseline gateway" bash benchmark/run.sh
BENCH_PI_MODEL="github-copilot/gpt-5.5" bash benchmark/run.sh
```

## What it measures

Each task runs for each selected profile.

| Metric | What it shows |
|---|---|
| **Duration** | End-to-end print-mode task duration. |
| **Provider tokens** | Token usage reported by Pi JSON usage events when available. |
| **Observed tool calls** | Best-effort tool-call count from Pi JSON events. |
| **Quality score** | How many expected key facts the response contains. |
| **Approx visible tokens** | Approximation from prompt + output chars / 4. |

## Tasks

| Task | Key facts expected |
|---|---|
| Deploy gateway to prod | ArgoCD, GitHub Actions, ECR, manual approval, Helm |
| Database pattern | Double-entry, immutable, integer cents, debit/credit |
| Project architecture | Hexagonal, Go 1.24, Chi, Next.js, PostgreSQL |
| Add Terraform module | modules/ dir, main.tf, terragrunt, live/ |
| Safe vs dangerous commands | plan, validate, destroy, caution |

## Expected results

With `gateway`:

- **Zero or near-zero unnecessary tool calls** — memory answers supported questions while still allowing source inspection when memory is incomplete.
- **Higher quality** — knows architecture decisions, conventions, and runbooks.
- **Faster responses** — compact gateway context avoids repeated repo exploration.
- **Lower visible token usage** — concise local summaries reduce assistant output and follow-up prompts.

## Output

Results saved to `/tmp/pi-memctx-benchmark/results/`:

- `*_baseline_r*.txt` — raw agent output without extensions
- `*_gateway_r*.txt` — raw agent output with pi-memctx profile `gateway`
- `*_metrics.json` — structured metrics per task/profile/repeat
- `summary-<run-id>.jsonl` — machine-readable aggregate rows
- `report-<run-id>.md` — human-readable report

## Notes

- The baseline uses `--no-extensions` so globally installed pi-memctx does not leak into the baseline.
- The memctx run uses `--no-extensions -e <repo>` so only the local extension under test is loaded.
- Profile config is isolated per run with `MEMCTX_CONFIG_PATH`.
- Visible token counts are approximate. Provider token usage is captured from Pi JSON usage events when the selected provider/model reports it; otherwise those fields may be zero.

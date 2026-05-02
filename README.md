<p align="center">
  <img src="https://em-content.zobj.net/source/apple/391/card-file-box_1f5c3-fe0f.png" width="120" alt="Card file box emoji" />
</p>

<h1 align="center">pi-memctx</h1>

<p align="center">
  <strong>Local-first memory context for Pi coding agents.</strong>
</p>

<p align="center">
  <a href="https://github.com/weauratech/pi-memctx/stargazers"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fapi.github.com%2Frepos%2Fweauratech%2Fpi-memctx&query=%24.stargazers_count&label=stars&color=yellow&style=flat&logo=github" alt="Stars"></a>
  <a href="https://github.com/weauratech/pi-memctx/commits/main"><img src="https://img.shields.io/github/last-commit/weauratech/pi-memctx?style=flat" alt="Last Commit"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/weauratech/pi-memctx?style=flat" alt="License"></a>
  <a href="https://github.com/weauratech/pi-memctx/releases/latest"><img src="https://img.shields.io/badge/release-v0.9.4-blue?style=flat" alt="Latest Release"></a>
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> •
  <a href="#why-it-feels-like-magic">Why</a> •
  <a href="#benchmark">Benchmark</a> •
  <a href="#how-it-works">How it works</a> •
  <a href="#memory-packs">Packs</a> •
  <a href="#commands">Commands</a> •
  <a href="#development">Development</a>
</p>

---

**Stop paying your coding agent to rediscover what your project already knows.**

`pi-memctx` gives [Pi](https://github.com/mariozechner/pi-coding-agent) a local, durable, Markdown-native memory layer. It searches your project memory before each prompt, injects only the context that matters, and lets the agent work normally when memory is not enough.

No database server. No hosted memory vendor. No new workflow for your users. Just launch Pi and ask the question.

## Quickstart

### 1. Install

```bash
pi install npm:pi-memctx
```

Or install from GitHub:

```bash
pi install git:github.com/weauratech/pi-memctx
```

You can also verify the local installation:

```bash
npx pi-memctx doctor
```

### 2. Start Pi with the extension

```bash
cd /path/to/your/workspace
pi -e pi-memctx
```

### 3. Generate your first memory pack

Inside Pi:

```txt
/memctx-pack-generate
```

`pi-memctx` scans the workspace and creates a structured Markdown memory pack with context, decisions, runbooks, and indexes.

### 4. Ask normally

```txt
How do I deploy this service to production?
```

The user experience stays the same: prompt, wait, get the answer. The Memory Gateway works behind the scenes.

## Why it feels like magic

A normal coding agent starts every session cold:

```txt
User: How do I deploy the gateway service to production?
Agent: I'll inspect the repo...
       [tool] list files
       [tool] read workflows
       [tool] inspect Helm charts
       [tool] search docs
       ...
```

`pi-memctx` turns that into:

```txt
User: How do I deploy the gateway service to production?
Agent: Merge to main, GitHub Actions builds Docker and pushes to ECR,
       Helm values are updated, ArgoCD syncs to Kubernetes, staging is
       automatic, and production is manual via ArgoCD approval/sync.
```

The difference is not a better prompt. It is **memory arriving before the model starts reasoning**.

## Benchmark

Latest local benchmark from the synthetic NovaPay fixture, 5 tasks, 1 repeat:

```bash
QMD_PATH=/tmp/pi-memctx-qmd/node_modules/.bin/qmd \
BENCH_REPEATS=1 \
BENCH_PROFILES="baseline gateway" \
BENCH_TIMEOUT=120 \
bash benchmark/run.sh /tmp/pi-memctx-benchmark-gateway-final
```

| Profile | Avg latency | Provider tokens/task | Visible tokens/task | Tool calls/task | Failed tools/task | Quality |
|---|---:|---:|---:|---:|---:|---:|
| baseline | 24.2s | 2,315 | 594 | 5.4 | 0.2 | 12/22 |
| gateway | 5.18s | 2,016 | 238 | 0.0 | 0.0 | 21/22 |

Compared with baseline:

| Profile | Latency | Provider tokens | Visible tokens | Tool calls | Quality |
|---|---:|---:|---:|---:|---:|
| gateway | **78.6% faster** | **12.9% fewer** | **59.9% fewer** | **100% fewer** | **+9 facts** |

Benchmarks are intentionally local and reproducible. Run them on your own projects:

```bash
bash benchmark/setup.sh /tmp/pi-memctx-benchmark
QMD_PATH=$(pwd)/node_modules/.bin/qmd \
BENCH_PROFILES="baseline gateway" \
bash benchmark/run.sh /tmp/pi-memctx-benchmark
```

## How it works

`pi-memctx` is a Memory Gateway between the user and the main LLM.

```txt
User prompt
   │
   ▼
Memory Gateway
   ├─ detects the active pack
   ├─ retrieves relevant Markdown memories with qmd or grep fallback
   ├─ ranks candidates with cheap semantic coverage
   ├─ builds a compact local memory summary
   └─ injects only useful context
   │
   ▼
Pi agent answers normally
   ├─ uses memory when sufficient
   ├─ inspects the repo when memory is partial or stale
   └─ can save durable discoveries back to Markdown
```

The gateway does **not** replace the main LLM. It does the boring part first: finding the right project memory, compressing it, and preventing redundant tool exploration when the answer is already known.

## Profile

`pi-memctx` now has one recommended runtime profile: `gateway`.

| Profile | Best for | Behavior |
|---|---|---|
| `gateway` | Fast daily use | Conservative local judge, compact context, qmd/grep retrieval, zero redundant memory searches when memory is sufficient. |

Inspect or re-apply the profile inside Pi:

```txt
/memctx-profile status
/memctx-profile gateway
```

Old profile names such as `gateway-lite`, `gateway-full`, `qmd-economy`, `low`, `balanced`, `auto`, and `full` are compatibility-mapped to `gateway`.

## Memory packs

A pack is a directory of Markdown files with frontmatter. You can edit it with any editor, commit it, review it, or open it in Obsidian.

```txt
packs/my-project/
  00-system/
    pi-agent/
      memory-manifest.md
      resource-map.md
    indexes/
      context-index.md
      decision-index.md
      runbook-index.md
  20-context/
    api.md
    web.md
    infra.md
  50-decisions/
    001-hexagonal-architecture.md
    002-use-pgx.md
  70-runbooks/
    deploy.md
    terraform.md
```

Recommended note types:

| Type | Use it for |
|---|---|
| `context` | Stack, services, repositories, conventions, environments. |
| `decision` | Architecture and technical decisions with rationale. |
| `runbook` | Repeatable operational procedures. |
| `observation` | Durable facts discovered during work. |
| `action` | Completed work, migrations, deploys, incident notes. |

## Commands

| Command | Purpose |
|---|---|
| `/memctx-pack-generate` | Create a memory pack from the current workspace. If a model is selected, deep LLM enrichment starts in the background by default; use `--no-deep` to skip it. |
| `/memctx-pack` | Select or show the active pack. |
| `/memctx-pack-status` | Show active pack and retrieval status. |
| `/memctx-profile` | Show or apply the `gateway` profile. |
| `/memctx-config` | Show current config. |
| `/memctx-retrieval` | Configure retrieval policy. |
| `/memctx-autosave` | Advanced: configure automatic learning behavior. The default gateway profile uses conservative `auto`. |
| `/memctx-save-queue` | Advanced: review queued lower-confidence memory candidates. |
| `/memctx-doctor` | Diagnose qmd, packs, and configuration. |
| `/memctx-pack-enrich` | Enrich a pack with deterministic repository inventory and optional LLM synthesis. Runs in the background. |

Deprecated aliases such as `/pack` and `/pack-generate` are still registered for compatibility.

## Tools

### `memctx_search`

Search the active memory pack:

```txt
Use memctx_search to find the deploy runbook.
```

Parameters:

| Parameter | Values | Default |
|---|---|---|
| `query` | string | required |
| `mode` | `keyword`, `semantic`, `deep` | `keyword` |
| `limit` | number | `5` |

When the Memory Gateway already injected sufficient memory, the agent is instructed not to call `memctx_search` again. That keeps answers fast and prevents duplicate context retrieval.

### `memctx_save`

Save durable knowledge into the active pack:

```txt
Remember that production deploys require ArgoCD manual approval.
```

The tool supports:

- `observation`
- `decision`
- `action`
- `runbook`
- `context`

Secret-looking content is blocked.

## qmd integration

`pi-memctx` uses [`@tobilu/qmd`](https://www.npmjs.com/package/@tobilu/qmd) when available for fast memory retrieval. To keep `pi install npm:pi-memctx` clean and warning-free, qmd is not installed automatically. If qmd is not available, pi-memctx falls back to grep-based search.

Resolution order:

1. `QMD_PATH` or `MEMCTX_QMD_BIN`
2. an already-installed local `.bin` or bundled/vendor path
3. `qmd` on `PATH`
4. grep fallback

Optional qmd install example:

```bash
npm install -g @tobilu/qmd
```

Check your setup:

```bash
npx pi-memctx doctor
```

## Safety model

`pi-memctx` is local-first and intentionally boring about sensitive data.

It will not save:

- API keys
- tokens
- passwords
- private keys
- customer data
- payment card data
- sensitive payloads

Memory is Markdown on disk. You can inspect every byte.

## Configuration

Most users should start with the defaults. Advanced users can configure behavior with environment variables or `/memctx-profile`.

Common environment variables:

| Variable | Purpose |
|---|---|
| `MEMCTX_CONTEXT_TOKEN_BUDGET` | Approximate injected context budget. |
| `MEMCTX_CONTEXT_MAX_ITEMS` | Maximum memory items to include. |
| `MEMCTX_RETRIEVAL` | Retrieval policy: `fast`, `balanced`, `deep`, `strict`, `auto`. |
| `MEMCTX_GATEWAY_JUDGE` | Gateway judge mode: `off`, `conservative`, `auto`, `main-llm`. |
| `MEMCTX_AUTOSAVE` | Autosave mode: `off`, `suggest`, `confirm`, `auto`. |
| `QMD_PATH` / `MEMCTX_QMD_BIN` | Explicit qmd binary path. |

## Development

Requirements:

- Node.js 20+
- Bun for tests
- Pi coding agent

Install dependencies:

```bash
npm install
```

Run checks:

```bash
npm run typecheck
npm test
npm run test:e2e
```

Run all CI checks:

```bash
npm run ci
```

Run benchmark:

```bash
bash benchmark/setup.sh /tmp/pi-memctx-benchmark
QMD_PATH=/tmp/pi-memctx-qmd/node_modules/.bin/qmd \
BENCH_REPEATS=1 \
BENCH_PROFILES="baseline gateway" \
BENCH_TIMEOUT=120 \
bash benchmark/run.sh /tmp/pi-memctx-benchmark
```

## Contributing

Issues and pull requests are welcome.

Good contributions include:

- better language-agnostic retrieval heuristics
- safer memory extraction
- clearer benchmark fixtures
- docs and examples
- profile tuning with reproducible numbers

Please do not commit private company memory packs, customer data, secrets, or benchmark fixtures derived from private repositories.

## License

MIT

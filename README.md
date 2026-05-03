<p align="center">
  <img src="https://em-content.zobj.net/source/apple/391/card-file-box_1f5c3-fe0f.png" width="120" alt="Card file box emoji" />
</p>

<h1 align="center">pi-memctx</h1>

<p align="center">
  <strong>Stop making Pi rediscover your repo every session.</strong>
</p>

<p align="center">
  <a href="https://github.com/weauratech/pi-memctx/stargazers"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fapi.github.com%2Frepos%2Fweauratech%2Fpi-memctx&query=%24.stargazers_count&label=stars&color=yellow&style=flat&logo=github" alt="Stars"></a>
  <a href="https://github.com/weauratech/pi-memctx/commits/main"><img src="https://img.shields.io/github/last-commit/weauratech/pi-memctx?style=flat" alt="Last Commit"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/weauratech/pi-memctx?style=flat" alt="License"></a>
  <a href="https://github.com/weauratech/pi-memctx/releases/latest"><img src="https://img.shields.io/badge/release-v0.11.0-blue?style=flat" alt="Latest Release"></a>
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> •
  <a href="#why-it-feels-like-magic">Why</a> •
  <a href="#automatic-learning">Learning</a> •
  <a href="#benchmark">Benchmark</a> •
  <a href="#how-it-works">How it works</a> •
  <a href="#workspace-memory">Workspace memory</a> •
  <a href="#commands">Commands</a> •
  <a href="#development">Development</a>
</p>

---

> **Stop making your coding agent rediscover your repo.**

`pi-memctx` gives [Pi](https://github.com/mariozechner/pi-coding-agent) a local, durable, Markdown-native memory layer. It searches project memory before each prompt, injects only compact/relevant context, lets Pi inspect the repo normally when memory is not enough, and learns durable discoveries after turns.

No database server. No hosted memory vendor. No hidden black box. Just Markdown memory packs you can read, edit, grep, version, and sync.

## Quickstart

### 1. Install

```bash
pi install npm:pi-memctx
```

Already installed? Update with:

```bash
pi update npm:pi-memctx
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
/memctx-init
```

`pi-memctx` scans the workspace and creates local Markdown workspace memory with context, decisions, runbooks, and indexes. Internally this is stored as a pack, but most users do not need to manage packs directly.

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

## Automatic learning

After a rich planning, debugging, or repository-discovery turn, `pi-memctx` can persist multiple linked Markdown notes instead of one shallow summary:

```txt
memctx: learned 5 memories:
   - context: [[packs/my-pack/20-context/payment-api|Payment API]] (updated)
   - observation: [[packs/my-pack/60-observations/deploy-patterns|Deploy patterns]] (created)
   - runbook: [[packs/my-pack/70-runbooks/deploy-payment-api|Deploy Payment API]] (created)
   - action: [[packs/my-pack/40-actions/2026-05-02-prepared-rollout|Prepared rollout]] (created)
   - session: [[packs/my-pack/80-sessions/rich-persistence-payment-api|Rich planning snapshot]] (created)
```

Learned notes are cross-linked with `[[wikilinks]]`, so future searches can recover the whole discovery: context, observations, runbooks, actions, decisions, and rich session snapshots.

## Local and inspectable by design

- Memories are Markdown files on your machine.
- No hosted memory service or external vector database is required.
- You can inspect, edit, delete, commit, or sync packs yourself.
- Secret-looking values are blocked/redacted before persistence.
- When memory is insufficient or stale, Pi falls back to normal repo inspection.

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

| Metric | Gateway vs baseline |
|---|---:|
| Latency | **78.6% faster** |
| Visible tokens | **59.9% fewer** |
| Tool calls | **100% fewer** |
| Quality | **+9 facts** |

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
   └─ after the turn, pi-memctx learns durable context back to Markdown
      ├─ context
      ├─ observations
      ├─ runbooks
      ├─ decisions
      ├─ actions
      └─ rich session snapshots
```

The gateway does **not** replace the main LLM. It does the boring part first: finding the right project memory, compressing it, and preventing redundant tool exploration when the answer is already known.

## Profile

`pi-memctx` now has one recommended runtime profile: `gateway`.

| Profile | Best for | Behavior |
|---|---|---|
| `gateway` | Fast daily use | Conservative local judge, compact context, qmd/grep retrieval, zero redundant memory searches when memory is sufficient. |

The profile is applied by default. Use `/memctx-status --advanced` if you need to inspect the active runtime settings. Old profile names such as `gateway-lite`, `gateway-full`, `qmd-economy`, `low`, `balanced`, `auto`, and `full` are compatibility-mapped to `gateway` in configuration files.

## Workspace memory

Each workspace gets local Markdown memory. Internally, workspace memory is stored as a pack directory with frontmatter. You can edit it with any editor, commit it, review it, or open it in Obsidian.

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
  40-actions/
    2026-05-02-prepared-rollout.md
  50-decisions/
    001-hexagonal-architecture.md
    002-use-pgx.md
  60-observations/
    deploy-patterns.md
  70-runbooks/
    deploy.md
    terraform.md
  80-sessions/
    rich-persistence-payment-api.md
```

Recommended note types:

| Type | Directory | Use it for |
|---|---|---|
| `context` | `20-context/` | Stack, services, repositories, conventions, environments. |
| `decision` | `50-decisions/` | Architecture and technical decisions with rationale. |
| `observation` | `60-observations/` | Durable facts, requirements, caveats, structural discoveries. |
| `runbook` | `70-runbooks/` | Repeatable operational procedures. |
| `action` | `40-actions/` | Completed work, migrations, deploys, incident notes. |
| `session` | `80-sessions/` | Sanitized rich planning/discovery snapshots for future retrieval. |

## Commands

Most users only need the daily commands:

| Command | Purpose |
|---|---|
| `/memctx` | Show compact help and current memory status. |
| `/memctx-init` | Create/update memory for this workspace. If a model is selected, deep LLM enrichment starts in the background by default; use `--no-deep` to skip it. |
| `/memctx-status` | Show workspace memory status; add `--advanced` for internal paths/config. |
| `/memctx-refresh` | Refresh workspace memory inventory/enrichment in the background. |
| `/memctx-doctor` | Diagnose qmd, workspace memory, and configuration. |

Older pack/config commands were removed from the public command surface to keep the extension simple. Advanced behavior is still configurable through environment variables and the local config file.

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
- `session`

Secret-looking content is blocked.

## Status overlay

`pi-memctx` keeps a small status overlay in Pi:

```txt
🧠 my-pack · memory ready · 3 memory hits · qmd · learn auto
```

This tells you which pack is active, whether memory was useful, which search backend is being used, and whether automatic learning is enabled.

## Best use cases

`pi-memctx` is especially useful when:

- you work on large repos or monorepos;
- Pi keeps rediscovering architecture and deploy flows;
- your team has many services with repeated conventions;
- you want local memory without a hosted vector database;
- you want agent memory you can read, edit, grep, and version;
- you want planning/discovery sessions to become durable project notes.

## Why not just RAG?

Most RAG setups retrieve documents at query time. `pi-memctx` is different:

- it is local-first and file-based;
- it stores durable memories as Markdown;
- it learns after turns, not only before prompts;
- it links related memories together;
- it can fall back to repo inspection when memory is stale;
- it does not require a hosted vector database.

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

Most users should start with the defaults. Advanced users can configure behavior with environment variables or the local config file at `~/.config/pi-memctx/config.json`.

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

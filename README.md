<p align="center">
  <img src="https://em-content.zobj.net/source/apple/391/card-file-box_1f5c3-fe0f.png" width="120" alt="Card file box emoji" />
</p>

<h1 align="center">pi-memctx</h1>

<p align="center">
  <strong>Local-first memory context for Pi coding agents.</strong>
</p>

<p align="center">
  <a href="https://github.com/weauratech/pi-memctx/stargazers"><img src="https://img.shields.io/github/stars/weauratech/pi-memctx?style=flat&color=yellow" alt="Stars"></a>
  <a href="https://github.com/weauratech/pi-memctx/commits/main"><img src="https://img.shields.io/github/last-commit/weauratech/pi-memctx?style=flat" alt="Last Commit"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/weauratech/pi-memctx?style=flat" alt="License"></a>
  <a href="package.json"><img src="https://img.shields.io/github/package-json/v/weauratech/pi-memctx?style=flat" alt="Version"></a>
</p>

<p align="center">
  <a href="#what-it-does">What it does</a> •
  <a href="#install">Install</a> •
  <a href="#setup">Setup</a> •
  <a href="#context-injection-priority">Context</a> •
  <a href="#tools">Tools</a> •
  <a href="#commands">Commands</a> •
  <a href="#documentation">Docs</a> •
  <a href="#development">Development</a>
</p>

---

Automatic memory context injection for [Pi coding agent](https://github.com/mariozechner/pi-mono).

**Your agent forgets everything between sessions.** Every new conversation starts from zero — re-discovering project structure, re-reading conventions, re-asking about deploy procedures. pi-memctx fixes this.

## The problem

Without persistent memory, coding agents waste time and tokens on every session:

```
You: "How do I deploy to production?"

Agent: Let me explore the project...
  $ find . -name "*.yml" | grep deploy      # scanning...
  $ cat .github/workflows/ci.yaml           # reading...
  $ ls kubernetes/                           # more scanning...
  $ cat README.md                            # still looking...
  
  → 30+ seconds, 8 tool calls, misses key details
```

## The fix

pi-memctx loads project context **before the agent starts thinking**:

```
You: "How do I deploy to production?"

Agent: Based on your deploy runbook:
  1. Push to main triggers GitHub Actions
  2. CI builds → Docker → ECR → Helm values update
  3. ArgoCD auto-syncs to staging
  4. Production requires manual approval in ArgoCD
  
  → 5 seconds, 0 tool calls, all key details correct
```

## Measured impact

Run `bash benchmark/setup.sh && bash benchmark/run.sh` to measure on your own project.

Typical results across 5 common tasks:

| Metric | Without | With pi-memctx | Gain |
|---|---|---|---|
| Tool calls per task | ~6 | ~1 | **80% fewer** |
| Correct facts in response | ~40% | ~95% | **2.4× better** |
| Time to answer | ~30s | ~5s | **6× faster** |
| Follow-up prompts needed | ~3 | ~0 | **First-pass accuracy** |

### What this means for your team

| If your team runs... | You save... |
|---|---|
| 10 agent tasks/day | ~500K tokens/month, ~25 min/month |
| 20 agent tasks/day | ~1M tokens/month, ~50 min/month |
| 50 agent tasks/day | ~2.5M tokens/month, ~2 hours/month |

Less tokens = lower API cost. Better answers = less rework. Faster responses = less waiting.

## Install

```bash
pi install npm:pi-memctx
```

Or install directly from GitHub:

```bash
pi install git:github.com/weauratech/pi-memctx
```

A GitHub Packages mirror is also published as `@weauratech/pi-memctx` for users who configure the GitHub npm registry.

## Quick start

### 1. Generate a pack from your project

```bash
cd /path/to/your/repos
pi -e pi-memctx

# Inside pi:
/memctx-pack-generate
```

This performs deterministic discovery across your repos — including read-first docs, package scripts, GitHub Actions, Git remotes, Go/Node manifests, safe development commands, and selected infrastructure hints — then builds a structured memory pack automatically.

### 2. Let the agent learn organically

As you work, the agent discovers and saves knowledge:

```
You: "remember that we use pgx instead of database/sql"

Agent: Saved decision: pgx-over-database-sql
       → packs/my-project/50-decisions/pgx-over-database-sql.md
```

The pack grows over time with real operational knowledge.

### 3. Knowledge persists across sessions

Next session, the agent already knows:

```
You: "set up a new database connection"

Agent: Based on your conventions, I'll use pgx with connection pooling
       (per your decision in pgx-over-database-sql)...
```

## How it works

```
pi starts → detect pack for cwd → load context
                                      │
user sends prompt ────────────────────┤
                                      │
  1. Search pack for relevant memories (policy-driven qmd/grep retrieval)
  2. Build prioritized context (manifest → context → search → actions → decisions → runbooks)
  3. Inject into system prompt (16K char budget)
                                      │
agent responds ───────────────────────┤
                                      │
  4. Agent can save learnings (memctx_save)
  5. Autosave can queue high-value memory candidates
  6. Session handoff captured on compaction
```

### Context priority

Not everything fits. Sections are included by priority — lower-priority content is trimmed first:

| Priority | What | Budget |
|---|---|---|
| 1 | Pack manifest + indexes | 2,000 chars |
| 2 | Context packs (stack, conventions) | 3,000 chars |
| 3 | Search results for current prompt | 2,500 chars |
| 4 | Recent actions | 2,000 chars |
| 5 | Decisions | 2,000 chars |
| 6 | Runbooks | 2,000 chars |

## Pack structure

Packs are just Markdown files with frontmatter. Edit them in any editor or Obsidian.

```
~/.pi/agent/memory-vault/packs/my-project/
  00-system/
    pi-agent/
      memory-manifest.md     # Pack entrypoint
      resource-map.md        # Repos, services, environments
    indexes/
      context-index.md       # Links to context packs
      decision-index.md      # Links to decisions
      runbook-index.md       # Links to runbooks
  20-context/
    backend.md               # Stack, architecture, conventions
    frontend.md              # Framework, components, build commands
  50-decisions/
    001-hexagonal-arch.md    # Why we chose this architecture
    002-use-pgx.md           # Why pgx over database/sql
  70-runbooks/
    deploy.md                # Step-by-step deploy procedure
    terraform.md             # Infrastructure operations
```

## Tools

pi-memctx exposes tools to the agent. You can ask the agent to use them directly, and the extension also performs automatic retrieval before each turn.

### `memctx_search`

Search across active-pack files:

```txt
use memctx_search to find information about deploy
```

Parameters:

| Parameter | Values | Default | Purpose |
|---|---|---:|---|
| `query` | string | required | Search terms or natural-language query. |
| `mode` | `keyword`, `semantic`, `deep` | `keyword` | Search strategy. Semantic/deep require qmd. |
| `limit` | number | `5` | Maximum result count. |

Search behavior:

1. qmd keyword/semantic/deep search when qmd is available;
2. grep-style Markdown fallback when qmd is unavailable, times out, or misses;
3. cross-pack hints when the active pack has no match but another pack appears relevant.

qmd resolution order:

1. `MEMCTX_QMD_BIN`
2. `qmd` on `PATH`
3. optional bundled `@tobilu/qmd` dependency at `node_modules/.bin/qmd`
4. grep fallback

Tuning:

```bash
MEMCTX_QMD_PROBE_TIMEOUT_MS=3000  # default: 1200
```

Without qmd, both automatic context injection and `memctx_search` use keyword grep fallback.

### `memctx_save`

Persist learnings to the active pack:

```txt
save this as a decision: we use integer cents for all monetary values
```

Parameters:

| Parameter | Values | Purpose |
|---|---|---|
| `type` | `observation`, `decision`, `action`, `runbook`, `context` | Destination note type. |
| `title` | string | Note title and filename slug source. |
| `content` | string | Markdown body. |
| `tags` | string[] | Optional extra tags. |

Behavior:

- writes Markdown notes with frontmatter into the active pack;
- appends to existing notes with the same slug;
- updates a matching index when available;
- blocks common secret, token, API key, AWS key, and private-key patterns.

## Commands

These slash commands are available inside Pi after the extension loads.

| Command | Usage | What |
|---|---|---|
| `/memctx-pack` | `/memctx-pack` or `/memctx-pack <name>` | List packs with a picker or switch directly. |
| `/memctx-pack-status` | `/memctx-pack-status` | Show active pack, selection reason/confidence, last switch, qmd status, strict mode, LLM stats, file count, and last retrieval. |
| `/memctx-strict` | `/memctx-strict on\|off\|status` | Toggle stronger Memory Gate guidance. Defaults to `on`; project-specific answers should call `memctx_search` unless injected memory fully supports the answer. |
| `/memctx-auto-switch` | `/memctx-auto-switch off\|cwd\|prompt\|all\|status` | Configure cwd/prompt-based automatic pack switching. |
| `/memctx-llm` | `/memctx-llm off\|assist\|first\|status` | Configure LLM assistance for prompt pack switching, retrieval expansion, autosave candidates, and pack generation. |
| `/memctx-retrieval` | `/memctx-retrieval auto\|fast\|balanced\|deep\|strict\|status` | Configure automatic retrieval depth. `auto` is the default. |
| `/memctx-autosave` | `/memctx-autosave off\|suggest\|confirm\|auto\|status` | Configure memory candidate capture after meaningful turns. |
| `/memctx-save-queue` | `/memctx-save-queue list\|approve <id>\|reject <id>\|clear` | Review queued memory candidates. |
| `/memctx-doctor` | `/memctx-doctor` | Diagnose active pack, qmd, retrieval, autosave, placeholders, duplicate note slugs, and secret-scan warnings. |
| `/memctx-pack-enrich` | `/memctx-pack-enrich [source-dir]` | LLM-enrich an existing active pack from source evidence. |
| `/memctx-pack-generate` | `/memctx-pack-generate [path] [slug]` | Generate a structured pack from a directory of repositories, with optional LLM deep enrichment. |

Deprecated aliases remain available for compatibility: `/pack`, `/pack-status`, and `/pack-generate`.

### `/memctx-pack-status` example

```txt
Active pack: opensource
Pack path: ~/.pi/agent/memory-vault/packs/opensource
Auto-switch: cwd
Retrieval policy: auto
Autosave: suggest
Save queue: 0 pending
Selection: high (112)
Last switch: none
qmd: available
qmd source: local-dependency
Strict mode: on
LLM mode: assist
LLM calls: 0
Overlay: 📦 opensource · qmd:3 · retrieval:auto · save:suggest · strict:on · llm:assist
Last retrieval: qmd
```

### `/memctx-pack-generate` discovery

`/memctx-pack-generate` performs deterministic local discovery before writing notes. It detects normal repos, hidden allowlist repos like `.github`, Git remotes, Node/TS and Go manifests, package scripts, safe commands, GitHub Actions, read-first docs, infra hints, placeholder repos, and redacts sensitive-looking values before persistence.

When `MEMCTX_LLM_MODE=assist` or `first` and a model is selected, it then asks the LLM to select important files from compact inventories and synthesize architecture notes from redacted snippets.

See [Pack generation](docs/pack-generate.md) for details.

## Multiple packs

With multiple packs, pi-memctx auto-detects the best one based on your working directory:

```bash
cd ~/code/my-api       # → loads "my-api" pack
cd ~/code/my-infra     # → loads "infra" pack
cd ~/code              # → loads org-level pack
```

Switch mid-session with `/memctx-pack`, or enable prompt-based switching:

```txt
/memctx-auto-switch all
/memctx-llm first
```

`assist` mode uses deterministic matching first and asks the LLM for ambiguous prompt decisions. `first` mode asks the LLM whenever possible while keeping deterministic validation/fallbacks.

For more aggressive memory behavior:

```txt
/memctx-retrieval strict      # more retrieval attempts before each turn
/memctx-autosave suggest     # queue memory candidates after meaningful work
/memctx-save-queue           # review pending candidates
/memctx-doctor               # diagnose pack/runtime health
```

Switch mid-session with `/memctx-pack`.

## Pack locations

Packs are resolved in order:

| Priority | Path | Use case |
|---|---|---|
| 1 | `MEMCTX_PACKS_PATH` env var | Explicit override |
| 2 | `<cwd>/.pi/memory-vault/packs/` | Project-local (share via git) |
| 3 | `~/.pi/agent/memory-vault/packs/` | Global default |

## Benchmark

Measure the impact on your own project:

```bash
# Setup fictional test scenario
bash benchmark/setup.sh

# Run 5 tasks with and without pi-memctx
bash benchmark/run.sh
```

## Documentation

- [Getting started](docs/getting-started.md)
- [Architecture](docs/architecture.md)
- [Safety](docs/safety.md)
- [Search](docs/search.md)
- [Persistence](docs/persistence.md)
- [Pack generation](docs/pack-generate.md)
- [Development](docs/development.md)
- [Publishing](docs/publishing.md)

## Development

```bash
npm ci
npm run typecheck
npm test
npm run test:e2e
npm run ci
```

Please read [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md) before opening a pull request.

## License

MIT

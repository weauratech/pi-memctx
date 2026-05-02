# Changelog

All notable changes to pi-memctx will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/) where practical.

## [Unreleased]


## [0.8.5] - 2026-05-02

### Fixed

- Remove deprecated transitive install dependency chains so `pi install npm:pi-memctx` no longer emits npm deprecation warnings from bundled dependencies.
- Resolve `@mariozechner/pi-ai` dynamically from the host Pi installation only when LLM-powered features are used.
- Keep qmd support optional through `QMD_PATH`, local/vendor binaries, or `PATH`, with grep fallback when qmd is unavailable.


## [0.8.4] - 2026-05-02

### Fixed

- Start LLM deep enrichment in the background by default during `/memctx-pack-generate` when a model is selected, with `--no-deep` available to skip it.
- Keep `/memctx-pack-enrich` responsive by deferring the deep job and continuing qmd indexing in the background.


## [0.8.3] - 2026-05-02

### Fixed

- Make pack generation include deterministic source inventory and stack signals in repository context notes.
- Add `/memctx-pack-generate --deep` for opt-in LLM-assisted deep enrichment when a model is selected.
- Bound repository scans and skip hidden/non-regular files so pack generation/enrichment does not stall on large workspaces or virtualenv-like trees.
- Move qmd indexing after pack generation to background so generation returns promptly.


## [0.8.2] - 2026-05-02

### Fixed

- Make `/memctx-pack-enrich` generate useful deterministic repository context notes even when LLM mode is off.
- Expand repository detection to infer Java, frontend, SQL/Flyway, Kubernetes/Kustomize, and Terraform evidence from source/config files.
- Stop gateway enrich from writing retired qmd-economy fact cards as the primary output.


## [0.8.1] - 2026-05-02

### Fixed

- Run `/memctx-pack-enrich` as a guarded background job so the Pi terminal remains responsive while enrichment and qmd indexing continue.


## [0.8.0] - 2026-05-02

### Changed

- Simplified pi-memctx to a single recommended `gateway` profile, with old profile names compatibility-mapped to `gateway`.
- Reworked the status overlay to show user-facing runtime information: active pack, gateway state, memory hits, search backend, profile, and learning mode.
- Updated README benchmark docs to compare only baseline vs `gateway`.


## [0.7.2] - 2026-05-02

### Fixed

- Migrate retired persisted profiles such as `qmd-economy`, `low`, `balanced`, `auto`, and `full` to the closest gateway profile so the status overlay no longer reports stale `ctx:qmd-economy` after upgrading.


## [0.7.1] - 2026-05-02

### Fixed

- Include gateway runtime files in the npm package so the extension can load `src/gateway/cheap-semantic.js` after installation.


## [0.7.0] - 2026-05-02

### Added

- Added the Memory Gateway runtime with `gateway-lite`, `gateway`, and `gateway-full` profiles.
- Added cheap semantic candidate ranking and local memory summaries for compact, high-signal context injection.
- Added `npx pi-memctx doctor` and improved qmd binary resolution.

### Changed

- Reworked the default experience around gateway-based memory evaluation instead of direct answer-plan injection.
- Updated benchmark tooling and documentation for baseline, gateway-lite, and gateway-full comparisons.
- Rewrote the README for the new open-source Memory Gateway architecture and latest benchmark results.


## [0.6.1] - 2026-05-01

### Changed

- Updated README benchmark results for the `qmd-economy` profile with measured local latency, token, tool-call, and quality improvements.
- Simplified benchmark defaults and docs to compare `baseline` against `qmd-economy` only.
<!-- Automatically released from fix/trigger-qmd-economy-release as a patch bump via #33. -->

## [0.6.0] - 2026-05-01

### Added

- Added the `qmd-economy` profile for direct answer-plan context with lower provider-token use.
- Added qmd-economy fact cards under `00-system/fact-cards/` for deploy, database, architecture, Terraform, and safety domains.
- Added qmd search/vsearch/query-assisted fact-card enrichment with deterministic fallback.
- Added progress notifications for `/memctx-pack-enrich` so long enrich runs are observable.

### Changed

- `/memctx-pack-enrich` can now run qmd-economy fact-card enrichment even when remote LLM mode is off.
- Benchmark tooling supports the `qmd-economy` profile.

<!-- Manually released after qmd-economy fact-card pipeline PR #31. -->

## [0.5.6] - 2026-05-01

### Fixed

- Keep the README release badge in sync during automatic release bumps.
<!-- Automatically released from fix/sync-readme-release-badge as a patch bump via #30. -->

## [0.5.5] - 2026-05-01

### Fixed

- Fixed the README stars badge by using a dynamic GitHub API count badge.
<!-- Automatically released from fix/readme-stars-badge as a patch bump via #29. -->

## [0.5.4] - 2026-05-01

### Fixed

- Fixed the README release badge URL so Shields renders the latest GitHub Release instead of `invalid`.
<!-- Automatically released from fix/readme-release-badge as a patch bump via #28. -->

## [0.5.3] - 2026-05-01

### Fixed

- Run the npmjs.com publish through npm 11 without replacing the runner's bundled npm.
- Upgrade npm in the release workflow so Trusted Publishing OIDC authentication is supported.
<!-- Automatically released from fix/use-npm-exec-for-trusted-publishing as a patch bump via #27. -->

## [0.5.2] - 2026-05-01

### Fixed

- Force the npmjs.com publish step to use Trusted Publishing OIDC instead of any inherited long-lived token.
<!-- Automatically released from fix/force-npm-trusted-publishing-auth as a patch bump via #25. -->

## [0.5.1] - 2026-05-01

### Fixed

- Use a release dependency install that can refresh peer metadata from the lockfile before publishing.
- Use deterministic release dependency installation from the lockfile.
<!-- Automatically released from fix/release-install-lock-update as a patch bump via #24. -->

## [0.5.0] - 2026-05-01

### Changed

- Added automatic release generation on `main` merges from `feat/*` and `fix/*` branches.
- Switched npm release publishing from `NPM_TOKEN` to npm Trusted Publishing with provenance.
<!-- Automatically released from feat/auto-release-on-main as a minor bump via #22. -->

## [0.4.0] - 2026-05-01

### Added

- Added `/memctx-profile auto|low|balanced|full|status` and persistent config in `~/.config/pi-memctx/config.json`; default profile is `auto`.
- Added `/memctx-config status|reset` for inspecting/resetting persistent config.
- Added configurable retrieval policy via `/memctx-retrieval` and `MEMCTX_RETRIEVAL=auto|fast|balanced|deep|strict`; default is `auto`.
- Added LLM-assisted query expansion for balanced/deep/strict retrieval policies.
- Added autosave memory candidates via `/memctx-autosave` and `MEMCTX_AUTOSAVE=off|suggest|confirm|auto`.
- Added save candidate review queue via `/memctx-save-queue`.
- Added `/memctx-doctor` for runtime and pack health diagnostics.
- Added `/memctx-pack-enrich` for LLM-assisted enrichment of existing packs.
- Added ask-first auto-bootstrap flow for creating a pack when no pack is found in a project directory.
- Added LLM-structured session handoffs during compaction when LLM mode is enabled.
- Added memory lookup hints after failed tool results.

### Changed

- Footer/status overlay now includes profile, retrieval policy, and autosave mode in addition to pack, qmd/retrieval, strict mode, and LLM mode.
- Strict mode now defaults to on for new installs and updates the footer/status overlay immediately when toggled.
- Automatic retrieval can now attempt multiple generated queries depending on retrieval policy.
- `retrieval:auto` is now latency-bounded with a default 1000ms budget and no longer escalates to full strict retrieval just because strict mode is enabled.
- `autosave:auto` now saves high-confidence candidates automatically without queue approval and does not queue low-confidence candidates unless explicitly configured.
- Context pack ordering now prioritizes overview and architecture notes before recency-only context.

### Fixed

- Suppressed false tool-failure memory hints when qmd reports `No results found`.
- Consolidated recent LLM, qmd, GitHub Packages, and memctx-command features into the next minor release line.

## [0.3.0] - 2026-04-30

### Added

- Added `/pack-status` command with active pack, pack path, qmd status/source/bin/error, qmd collection, strict mode, file count, and last retrieval diagnostics.
- Added `/memctx-strict on|off|status` and `MEMCTX_STRICT` support for stronger Memory Gate guidance.
- Added automatic qmd resolution from `MEMCTX_QMD_BIN`, `PATH`, or optional bundled `@tobilu/qmd`.
- Added `MEMCTX_QMD_PROBE_TIMEOUT_MS` to tune qmd probe timeouts.
- Added prompt-specific retrieval before each agent turn with grep fallback when qmd is unavailable, times out, or misses.
- Added Memory Gate guidance to injected context.
- Added deep deterministic `/pack-generate` discovery for repositories, hidden allowlist repos like `.github`, docs, package scripts, GitHub Actions, Git remotes, Go/Node manifests, safe commands, infrastructure hints, placeholder repos, project notes, observations, runbooks, and indexes.
- Added `docs/pack-generate.md`.
- Added release automation plan support through GitHub Actions.

### Changed

- Moved `@sinclair/typebox` to runtime dependencies.
- Made `@tobilu/qmd` an optional dependency so pi-memctx can degrade safely to grep fallback.
- Pack generation now creates the full memory-pack directory structure.
- `memctx_search` now shares the same qmd/grep fallback pipeline as automatic retrieval.
- Documentation now describes tools, slash commands, qmd resolution, strict mode, pack status, and pack generation.

### Fixed

- qmd probing now fails fast and reports probe errors in `/pack-status`.
- Generated pack content redacts high-confidence secret-looking values before persistence.
- CI installs omit optional qmd dependencies and optional peer dependencies for stable core tests.

## [0.2.1] - 2026-04-30

### Added

- Open-source community health files: contributing guide, security policy, support policy, code of conduct, issue templates, and pull request template.
- GitHub Actions CI for typecheck, unit tests, and e2e tests.
- Documentation for getting started, architecture, safety, search, persistence, development, and publishing.
- Example memory pack and reusable note templates.

### Changed

- E2E test now generates a temporary deterministic memory pack instead of depending on local files.
- TypeScript typecheck is part of the supported development workflow.

## [0.1.0] - 2026-04-30

### Added

- Initial Pi extension for automatic memory context injection.
- `memctx_search` tool with qmd support and grep fallback.
- `memctx_save` tool with secret-pattern blocking.
- `/pack` and `/pack-generate` commands.
- Session handoff capture before compaction.

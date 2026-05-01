# Changelog

All notable changes to pi-memctx will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/) where practical.

## [Unreleased]


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

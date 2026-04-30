# Changelog

All notable changes to pi-memctx will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/) where practical.

## [Unreleased]

### Added

- Open-source community health files: contributing guide, security policy, support policy, code of conduct, issue templates, and pull request template.
- GitHub Actions CI for typecheck, unit tests, and e2e tests.
- Documentation for getting started, architecture, safety, search, persistence, development, and publishing.
- Example memory pack and reusable note templates.

### Changed

- E2E test now generates a temporary deterministic memory pack instead of depending on local files.
- TypeScript typecheck is part of the supported development workflow.

## [0.1.0]

### Added

- Initial Pi extension for automatic memory context injection.
- `memctx_search` tool with qmd support and grep fallback.
- `memctx_save` tool with secret-pattern blocking.
- `/pack` and `/pack-generate` commands.
- Session handoff capture before compaction.

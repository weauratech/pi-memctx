# AGENTS.md — pi-memctx

This repository is a Pi extension package for local-first memory context.

## What to read first

1. `README.md` for product direction and install flow.
2. `docs/architecture.md` before changing runtime behavior.
3. `docs/safety.md` before changing persistence, context injection, or secret detection.
4. `CONTRIBUTING.md` before preparing a pull request.

## Important entrypoints

- Extension runtime: `index.ts`
- Unit tests: `test/unit.test.ts`
- E2E test: `test/e2e.ts`
- Getting started: `docs/getting-started.md`
- Architecture: `docs/architecture.md`
- Safety model: `docs/safety.md`

## Required checks

Run before committing:

```bash
npm run ci
```

This runs TypeScript typecheck, unit tests, and the generated-pack e2e test.

## Safety rules

Never add secrets, tokens, passwords, private keys, credentials, customer data, production payloads, or private memory-pack content to this repository.

When changing `memctx_save`, preserve or strengthen secret blocking. When changing context injection, keep budgets bounded and make source-of-truth precedence explicit.

## Documentation rule

If behavior changes, update `README.md` or the relevant doc under `docs/`. If contributor expectations change, update `CONTRIBUTING.md` and the PR template.

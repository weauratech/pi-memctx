# Contributing to pi-memctx

Thanks for considering a contribution.

pi-memctx is a Pi extension for local-first agent memory. It injects relevant Markdown-pack context into Pi sessions and provides tools to search and safely persist durable learnings.

## Ground rules

- Keep the project generic and reusable.
- Do not add private company, client, customer, or personal sensitive context.
- Do not add secrets, tokens, passwords, private keys, credentials, payment data, or sensitive payloads.
- Prefer small, focused pull requests.
- Update README or docs when behavior changes.
- Add or update tests for extension behavior changes.

## Development setup

```bash
git clone https://github.com/weauratech/pi-memctx.git
cd pi-memctx
npm ci
npm run ci
```

Useful commands:

```bash
npm test             # unit tests
npm run typecheck    # TypeScript typecheck
npm run test:e2e     # generated-pack integration test
npm run ci           # all required checks
```

## Pull request checklist

Before opening a PR, verify:

- [ ] The change is generic and safe for a public repository.
- [ ] No secrets or sensitive data were added.
- [ ] Extension behavior changes include tests.
- [ ] `npm run ci` passes locally.
- [ ] README or docs were updated if user-facing behavior changed.
- [ ] Breaking changes include migration notes.

## Commit style

Use concise conventional-style commits when practical:

```txt
feat: add pack generation command
fix: avoid saving secret-like content
docs: document qmd fallback behavior
```

## Security issues

Do not open public issues for vulnerabilities or accidental sensitive data exposure. Follow `SECURITY.md`.

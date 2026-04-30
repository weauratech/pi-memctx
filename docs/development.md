# Development

## Requirements

- Node.js 20+
- Bun
- npm

## Setup

```bash
npm ci
```

## Checks

```bash
npm run typecheck
npm test
npm run test:e2e
npm run ci
```

The e2e test creates a temporary memory pack and does not depend on private local files.

## Project layout

```txt
index.ts          # Pi extension runtime
test/unit.test.ts # unit tests
test/e2e.ts      # generated-pack integration test
docs/            # user and maintainer docs
examples/         # public-safe example packs
templates/        # reusable note templates
```

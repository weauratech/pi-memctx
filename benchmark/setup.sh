#!/usr/bin/env bash
# Setup a self-contained benchmark scenario for pi-memctx.
# Creates a fictional project "NovaPay" with fake repos and a memory pack.
#
# Usage: bash benchmark/setup.sh [base_dir]

set -euo pipefail

BASE_DIR="${1:-/tmp/pi-memctx-benchmark}"

echo "🔧 Setting up benchmark at: $BASE_DIR"
rm -rf "$BASE_DIR"
mkdir -p "$BASE_DIR"

# ─────────────────────────────────────────────────────────
# 1. Create fake repos (simulating a real org)
# ─────────────────────────────────────────────────────────

echo "📦 Creating fake repos..."

# --- novapay-api: Go microservices ---
mkdir -p "$BASE_DIR/repos/novapay-api/gateway/cmd"
mkdir -p "$BASE_DIR/repos/novapay-api/gateway/internal/domain"
mkdir -p "$BASE_DIR/repos/novapay-api/gateway/internal/adapters"
mkdir -p "$BASE_DIR/repos/novapay-api/accounts/cmd"
mkdir -p "$BASE_DIR/repos/novapay-api/accounts/internal/domain"
mkdir -p "$BASE_DIR/repos/novapay-api/transactions/cmd"
mkdir -p "$BASE_DIR/repos/novapay-api/transactions/internal/domain"

cat > "$BASE_DIR/repos/novapay-api/gateway/go.mod" << 'EOF'
module github.com/novafintech/novapay-api/gateway

go 1.24.0

require (
	github.com/go-chi/chi/v5 v5.0.12
	github.com/jackc/pgx/v5 v5.6.0
)
EOF

cat > "$BASE_DIR/repos/novapay-api/gateway/cmd/main.go" << 'EOF'
package main

import (
	"log"
	"net/http"
	"github.com/go-chi/chi/v5"
)

func main() {
	r := chi.NewRouter()
	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"status":"ok"}`))
	})
	log.Fatal(http.ListenAndServe(":8080", r))
}
EOF

cat > "$BASE_DIR/repos/novapay-api/gateway/Makefile" << 'EOF'
.PHONY: build test lint run

build:
	go build -o bin/gateway ./cmd/...

test:
	go test ./...

lint:
	golangci-lint run

run:
	go run ./cmd/main.go
EOF

cat > "$BASE_DIR/repos/novapay-api/gateway/Dockerfile" << 'EOF'
FROM golang:1.24-alpine AS builder
WORKDIR /app
COPY go.* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /gateway ./cmd/main.go

FROM alpine:3.19
COPY --from=builder /gateway /gateway
EXPOSE 8080
CMD ["/gateway"]
EOF

cat > "$BASE_DIR/repos/novapay-api/README.md" << 'EOF'
# NovaPay API

Payment processing microservices built with Go.

## Services

| Service | Port | Purpose |
|---|---|---|
| gateway | 8080 | API gateway, routing, auth middleware |
| accounts | 8081 | Account management, KYC |
| transactions | 8082 | Payment processing, ledger |

## Architecture

Hexagonal architecture with domain-driven design:
- `internal/domain/` — business entities and interfaces
- `internal/adapters/` — PostgreSQL, Redis, HTTP implementations

## Stack

- Go 1.24
- Chi router
- PostgreSQL 16 + pgx
- Redis for caching
- Docker + Kubernetes

## Build

```bash
cd <service>
make build
make test
```

## Deploy

CI/CD via GitHub Actions → Docker → ECR → ArgoCD → Kubernetes.
Tag-driven: push to main triggers auto-deploy to staging.
Production requires manual approval in ArgoCD.
EOF

# --- novapay-web: Next.js frontend ---
mkdir -p "$BASE_DIR/repos/novapay-web/src/app"
mkdir -p "$BASE_DIR/repos/novapay-web/src/components"

cat > "$BASE_DIR/repos/novapay-web/package.json" << 'EOF'
{
  "name": "novapay-web",
  "version": "1.0.0",
  "description": "NovaPay merchant dashboard and checkout",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "eslint src/"
  },
  "dependencies": {
    "next": "14.2.0",
    "react": "18.3.0",
    "tailwindcss": "3.4.0"
  }
}
EOF

cat > "$BASE_DIR/repos/novapay-web/README.md" << 'EOF'
# NovaPay Web

Merchant dashboard and checkout frontend.

## Stack

- Next.js 14 (App Router)
- React 18
- Tailwind CSS
- shadcn/ui components

## Apps

- `/dashboard` — Merchant portal (transactions, settlements, API keys)
- `/checkout/:id` — Customer payment page (PCI-compliant, tokenized)
- `/admin` — Internal backoffice

## Development

```bash
npm install
npm run dev
# → http://localhost:3000
```
EOF

# --- novapay-infra: Terraform ---
mkdir -p "$BASE_DIR/repos/novapay-infra/modules/vpc"
mkdir -p "$BASE_DIR/repos/novapay-infra/modules/eks"
mkdir -p "$BASE_DIR/repos/novapay-infra/modules/rds"
mkdir -p "$BASE_DIR/repos/novapay-infra/live/dev/us-east-1"
mkdir -p "$BASE_DIR/repos/novapay-infra/live/prod/us-east-1"

cat > "$BASE_DIR/repos/novapay-infra/README.md" << 'EOF'
# NovaPay Infrastructure

Terraform + Terragrunt IaC for NovaPay platform.

## Modules

| Module | Purpose |
|---|---|
| vpc | VPC with public/private subnets |
| eks | EKS cluster with managed node groups |
| rds | PostgreSQL RDS instances |

## Environments

| Env | Region | Path |
|---|---|---|
| dev | us-east-1 | `live/dev/us-east-1/` |
| prod | us-east-1 | `live/prod/us-east-1/` |

## Usage

```bash
cd live/dev/us-east-1
terragrunt run-all plan
terragrunt run-all apply  # CAUTION: modifies real infra
```

## Safe commands

- `terragrunt plan` — read-only, always safe
- `terragrunt validate` — syntax check

## Dangerous commands

- `terragrunt apply` — modifies infrastructure
- `terragrunt destroy` — NEVER on prod without approval
EOF

cat > "$BASE_DIR/repos/novapay-infra/modules/vpc/main.tf" << 'EOF'
variable "cidr_block" {
  default = "10.0.0.0/16"
}

resource "aws_vpc" "main" {
  cidr_block           = var.cidr_block
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name = "novapay-${var.environment}"
  }
}
EOF

# --- novapay-helm: Helm charts ---
mkdir -p "$BASE_DIR/repos/novapay-helm/charts/gateway/templates"
mkdir -p "$BASE_DIR/repos/novapay-helm/charts/accounts/templates"
mkdir -p "$BASE_DIR/repos/novapay-helm/charts/web/templates"

cat > "$BASE_DIR/repos/novapay-helm/README.md" << 'EOF'
# NovaPay Helm Charts

Helm charts for all NovaPay services.

## Charts

| Chart | Service |
|---|---|
| gateway | API gateway |
| accounts | Account management |
| transactions | Payment processing |
| web | Next.js frontend |

## Lint

```bash
ct lint --all
```

## Deploy

ArgoCD syncs from this repo. Update `values.yaml` with new image tags.
EOF

echo "✅ Fake repos created"

# ─────────────────────────────────────────────────────────
# 2. Create memory pack
# ─────────────────────────────────────────────────────────

echo "📝 Creating memory pack..."

PACK_DIR="$BASE_DIR/packs/novapay"
mkdir -p "$PACK_DIR/00-system/pi-agent"
mkdir -p "$PACK_DIR/00-system/indexes"
mkdir -p "$PACK_DIR/20-context"
mkdir -p "$PACK_DIR/50-decisions"
mkdir -p "$PACK_DIR/70-runbooks"

cat > "$PACK_DIR/00-system/pi-agent/memory-manifest.md" << 'EOF'
---
type: system
id: system.novapay.memory-manifest
title: NovaPay Memory Manifest
status: active
source_of_truth: true
tags:
  - agent-memory/system
  - pack/novapay
---

# NovaPay Memory Manifest

Memory pack for the **NovaPay** payment platform.

## Indexes

- [[packs/novapay/00-system/indexes/context-index|Context Index]]
- [[packs/novapay/00-system/indexes/decision-index|Decision Index]]
- [[packs/novapay/00-system/indexes/runbook-index|Runbook Index]]

## Safety

Never store API keys, database passwords, payment card numbers, or customer PII.
EOF

cat > "$PACK_DIR/00-system/pi-agent/resource-map.md" << 'EOF'
---
type: system
id: system.novapay.resource-map
title: Resource Map
status: active
source_of_truth: true
tags:
  - agent-memory/resources
  - pack/novapay
---

# Resource Map

## Repositories

| Name | Purpose |
|---|---|
| `novapay-api` | Go microservices — gateway, accounts, transactions |
| `novapay-web` | Next.js frontend — dashboard, checkout, admin |
| `novapay-infra` | Terraform IaC — VPC, EKS, RDS |
| `novapay-helm` | Helm charts for all services |

## Kubernetes

| Namespace | Services |
|---|---|
| `novapay` | gateway, accounts, transactions, web |

## Environments

| Env | Region |
|---|---|
| dev | us-east-1 |
| prod | us-east-1 |
EOF

cat > "$PACK_DIR/20-context/api.md" << 'EOF'
---
type: context-pack
id: context.novapay.api
title: NovaPay API
status: active
tags:
  - pack/novapay
  - agent-memory/context-pack
---

# NovaPay API

## Services

| Service | Port | Purpose |
|---|---|---|
| gateway | 8080 | API gateway, routing, auth middleware |
| accounts | 8081 | Account management, KYC |
| transactions | 8082 | Payment processing, double-entry ledger |

## Architecture

Hexagonal architecture:
- `internal/domain/` — business entities and port interfaces
- `internal/adapters/` — PostgreSQL, Redis, HTTP implementations
- Domain never imports adapters

## Stack

- Go 1.24, Chi router, pgx, Redis
- Each service has its own `go.mod`
- Tests use testcontainers

## Build

```bash
cd <service>
make build && make test && make lint
```

## Related

- [[packs/novapay/50-decisions/001-hexagonal-arch|Hexagonal Architecture]]
- [[packs/novapay/70-runbooks/deploy|Deploy Runbook]]
EOF

cat > "$PACK_DIR/20-context/web.md" << 'EOF'
---
type: context-pack
id: context.novapay.web
title: NovaPay Web
status: active
tags:
  - pack/novapay
  - agent-memory/context-pack
---

# NovaPay Web

## Stack

- Next.js 14 (App Router), React 18, Tailwind CSS, shadcn/ui

## Routes

- `/dashboard` — Merchant portal
- `/checkout/:id` — Customer payment page (PCI-compliant, tokenized)
- `/admin` — Internal backoffice

## Dev

```bash
npm install && npm run dev  # → http://localhost:3000
```

## Related

- [[packs/novapay/20-context/api|NovaPay API]]
EOF

cat > "$PACK_DIR/20-context/infra.md" << 'EOF'
---
type: context-pack
id: context.novapay.infra
title: Infrastructure
status: active
tags:
  - pack/novapay
  - agent-memory/context-pack
---

# Infrastructure

## IaC

Terraform + Terragrunt. Modules: vpc, eks, rds.

## Environments

- dev: `live/dev/us-east-1/`
- prod: `live/prod/us-east-1/`

## Safe commands

```bash
terragrunt plan       # always safe
terragrunt validate   # syntax only
```

## Dangerous commands

- `terragrunt apply` — modifies real infra
- `terragrunt destroy` — NEVER on prod

## Related

- [[packs/novapay/70-runbooks/terraform|Terraform Runbook]]
EOF

cat > "$PACK_DIR/50-decisions/001-hexagonal-arch.md" << 'EOF'
---
type: decision
id: decision.novapay.001-hexagonal-arch
title: Hexagonal Architecture
status: accepted
tags:
  - pack/novapay
  - agent-memory/decision
---

# Hexagonal Architecture

## Decision

All Go services use hexagonal architecture (ports and adapters).

## Rules

- `domain/` must not import `adapters/`
- Interfaces defined in `domain/`, implemented in `adapters/`
- Tests mock domain ports, not adapters
EOF

cat > "$PACK_DIR/50-decisions/002-double-entry-ledger.md" << 'EOF'
---
type: decision
id: decision.novapay.002-double-entry-ledger
title: Double-Entry Ledger
status: accepted
tags:
  - pack/novapay
  - agent-memory/decision
---

# Double-Entry Ledger

## Decision

Transaction service uses double-entry bookkeeping.

## Rules

- Every transaction = 1 debit + 1 credit entry
- Entries are immutable (corrections = reversal entries)
- Amounts stored as integer cents (no floats)
- Balance = SUM(credits) - SUM(debits) per account
- No UPDATE/DELETE on ledger table — append-only

## Schema

```sql
CREATE TABLE ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL,
  account_id UUID NOT NULL,
  entry_type TEXT CHECK (entry_type IN ('debit', 'credit')),
  amount_cents BIGINT CHECK (amount_cents > 0),
  currency TEXT DEFAULT 'USD',
  created_at TIMESTAMPTZ DEFAULT now()
);
```
EOF

cat > "$PACK_DIR/50-decisions/003-chi-router.md" << 'EOF'
---
type: decision
id: decision.novapay.003-chi-router
title: Chi Router for HTTP
status: accepted
tags:
  - pack/novapay
  - agent-memory/decision
---

# Chi Router

## Decision

Use go-chi/chi v5 for HTTP routing.

## Rationale

- stdlib-compatible (`net/http` patterns)
- Middleware chain: logging → recovery → auth → rate-limit → handler
- Route groups by version: `/api/v1/...`
- No framework lock-in
EOF

cat > "$PACK_DIR/70-runbooks/deploy.md" << 'EOF'
---
type: runbook
id: runbook.novapay.deploy
title: Deploy Services
status: active
tags:
  - pack/novapay
  - agent-memory/runbook
---

# Deploy Services

## CI/CD Flow

```
Push to main → GitHub Actions
  ├─ lint + test
  ├─ docker build → ECR
  ├─ update Helm values (image tag)
  └─ ArgoCD syncs to Kubernetes
```

## Deploy to Staging (automatic)

Merge to `main` triggers auto-deploy.

## Deploy to Production (manual)

1. Verify staging is stable
2. ArgoCD UI → select app → Sync

## Verify

```bash
curl -s https://api.novapay.dev/health | jq .
kubectl get pods -n novapay
```

## Rollback

```bash
# ArgoCD: History → select previous → Rollback
# Or: git revert on novapay-helm
```

## Build locally

```bash
cd novapay-api/<service>
make build && make test
```
EOF

cat > "$PACK_DIR/70-runbooks/terraform.md" << 'EOF'
---
type: runbook
id: runbook.novapay.terraform
title: Terraform Operations
status: active
tags:
  - pack/novapay
  - agent-memory/runbook
---

# Terraform Operations

## Plan

```bash
cd novapay-infra/live/<env>/us-east-1
terragrunt run-all plan
```

## Apply (dev)

```bash
terragrunt run-all apply
```

## Apply (prod) — requires approval

```bash
terragrunt run-all plan   # share with team first
terragrunt run-all apply  # after approval
```

## Add new module

1. Create `modules/<name>/` with main.tf, variables.tf, outputs.tf
2. Create `live/<env>/us-east-1/<name>/terragrunt.hcl`
3. Plan → review → apply
EOF

# Indexes
cat > "$PACK_DIR/00-system/indexes/context-index.md" << 'EOF'
---
type: index
id: index.novapay.context-index
title: Context Index
status: active
tags:
  - agent-memory/index
  - pack/novapay
---

# Context Index

| Note | Use |
|---|---|
| [[packs/novapay/20-context/api\|NovaPay API]] | Go microservices — gateway, accounts, transactions |
| [[packs/novapay/20-context/web\|NovaPay Web]] | Next.js frontend — dashboard, checkout, admin |
| [[packs/novapay/20-context/infra\|Infrastructure]] | Terraform — VPC, EKS, RDS |
EOF

cat > "$PACK_DIR/00-system/indexes/decision-index.md" << 'EOF'
---
type: index
id: index.novapay.decision-index
title: Decision Index
status: active
tags:
  - agent-memory/index
  - pack/novapay
---

# Decision Index

| Note | Use |
|---|---|
| [[packs/novapay/50-decisions/001-hexagonal-arch\|Hexagonal Architecture]] | Ports and adapters for Go |
| [[packs/novapay/50-decisions/002-double-entry-ledger\|Double-Entry Ledger]] | Append-only, integer cents |
| [[packs/novapay/50-decisions/003-chi-router\|Chi Router]] | stdlib-compatible HTTP routing |
EOF

cat > "$PACK_DIR/00-system/indexes/runbook-index.md" << 'EOF'
---
type: index
id: index.novapay.runbook-index
title: Runbook Index
status: active
tags:
  - agent-memory/index
  - pack/novapay
---

# Runbook Index

| Note | Use |
|---|---|
| [[packs/novapay/70-runbooks/deploy\|Deploy Services]] | CI/CD, staging, prod, rollback |
| [[packs/novapay/70-runbooks/terraform\|Terraform Operations]] | Plan, apply, new modules |
EOF

echo "✅ Memory pack created: $PACK_DIR"
echo ""
echo "📊 Summary:"
echo "   Repos: $(ls $BASE_DIR/repos | wc -l | tr -d ' ')"
echo "   Pack files: $(find $PACK_DIR -name '*.md' | wc -l | tr -d ' ')"
echo ""
echo "To run the benchmark:"
echo "   bash benchmark/run.sh $BASE_DIR"

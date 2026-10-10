# First Implementation Tasks

## Sprint 1 – Foundation
1. Init monorepo: `apps/api` (Node + TypeScript + Fastify/Express), `apps/web` (React + Vite), shared `packages/types`.
2. Set up PostgreSQL (docker-compose for local) and a migration tool (e.g. node-pg-migrate / Prisma); convert `apps/api/prisma/schema.prisma` into the first migration.
3. Config via env vars, structured logging, `/health` endpoint, lint/format/test tooling, CI (lint + test).
4. Auth: login, refresh, logout, password hashing, RBAC middleware, seed admin user.
5. Audit-log helper used by all mutating sensitive endpoints.

## Sprint 2 – Catalog & inventory
6. CRUD: categories, brands, tax rates, products + variants + barcodes (with validation, unique SKU/barcode).
7. Product search + barcode lookup endpoint (indexes in place); CSV import/export.
8. Stock service: ledger insert + `stock_levels` update in one transaction; adjustments; low-stock query.
9. Suppliers, purchase orders, goods receipt.

## Sprint 3 – Checkout
10. Pricing/tax engine (pure, unit-tested: inclusive/exclusive tax, discounts, rounding).
11. `POST /sales` idempotent transaction: lock stock rows, write sale, items, payments, stock movements.
12. Hold/resume carts; receipt rendering (HTML print, 80mm).
13. POS UI: scan/search, cart, discounts, split payment, receipt.

## Sprint 4 - done
Returns/refunds (idempotent, concurrency-safe, pending external refunds), shifts and cash drawer with reconciliation and approval, server-side reports, variant management, customers, and matching screens. 83 API tests, 14 unit tests, 26 e2e tests.

## Sprint 5 - done
Production config validation and hardening, admin provisioning, health/readiness, structured redacted logs, encrypted backups with verified restore, CSV/PDF exports, held-sale voids, exchanges, hardware abstraction layer, Docker/proxy/deploy prep and docs. Not deployed; Docker files untested (no Docker locally).

## Later – Returns, shifts, reports, deploy
14. Payment-provider integration, resume held sales, raw ESC/POS transport once hardware is chosen.
15. Build/smoke-test Docker images; staging dry run; WAL archiving for a tighter RPO.
16. Public deployment (requires explicit approval).

## Definition of done
Unit + integration tests (real Postgres), migrations reversible, RBAC checked per endpoint, docs updated.

## Open questions
- Country/tax regime (GST, VAT, sales tax) and currency?
- Receipt printer / barcode scanner models?
- Preferred stack, or is the assumed one OK?
- Expected scale (SKUs, daily transactions, registers)?


## Sprint 5.1 - Docker verification & reliability (partially complete)
- [ ] Docker image build - NOT VERIFIED (no Docker/WSL/hypervisor on dev machine). Run `.github/workflows/docker-verify.yml` or the manual steps in `docs/DEPLOYMENT.md`.
- [ ] Compose stack, health/readiness, containerised checkout, containerised backup/restore - NOT VERIFIED.
- [x] Static review of deploy files: fixed PG 18 volume mount path in `docker-compose.prod.yml`.
- [x] Secrets/cookies/config: verified natively by `production.test.ts` and `startup.test.ts` (not in containers).
- [x] Load test (`npm run loadtest`, 5-10 concurrent cashiers): invoice uniqueness/contiguity, idempotent replays, stock, reports all exact. Results in `docs/DEPLOYMENT.md`.
- [x] WAL/PITR evaluated (recommendation in `docs/BACKUP-RECOVERY.md`); not implemented.
- [x] Docs updated: troubleshooting, rollback, limitations.
- Limitations: Docker unverified; load numbers are local/native; RPO is ~24 h until PITR is adopted; per-IP rate limits shared by all registers behind one NAT.

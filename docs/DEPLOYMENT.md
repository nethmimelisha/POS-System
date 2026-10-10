# Deployment

> These deployment files were authored without Docker on the authoring machine. They were not build-tested here, and nothing from this repository has been deployed publicly from this environment.

## Target shape

- 1 store
- 2 active registers
- ~20,000 products
- Browser printing only; direct ESC/POS printing requires a separate local print bridge and is not included here

For this footprint, start with:

- 2 vCPU
- 4 GB RAM
- 60+ GB SSD
- regular off-host backup copy of the `/backups` volume

Running PostgreSQL on the same host is acceptable at this size if storage latency is low and backups are monitored.

## Prerequisites

- Docker Engine with the Compose plugin on the target host
- A Linux host with enough disk for images, Postgres data, and encrypted backups
- DNS for your production hostname (for example `pos.example.lk`)
- TLS certificates for `deploy\certs\fullchain.pem` and `deploy\certs\privkey.pem` if you use the provided edge nginx
- A completed `deploy\.env.production`

## Files

- `deploy\Dockerfile.api` - API build, migrate, and runtime image
- `deploy\Dockerfile.web` - web build + nginx image
- `deploy\docker-compose.prod.yml` - production stack
- `deploy\nginx\web.conf` - SPA/static nginx that also proxies `/api/`, `/health`, and `/ready`
- `deploy\nginx\edge.conf` - TLS-terminating nginx
- `deploy\Caddyfile` - simpler automatic-HTTPS alternative

## Configuration

1. Copy `deploy\.env.production.example` to `deploy\.env.production`.
2. Set a strong `POSTGRES_PASSWORD`, and keep the `DATABASE_URL` password identical.
3. Set `POS_DOMAIN` and `CORS_ORIGIN` to the real HTTPS origin.
4. Generate `BACKUP_ENCRYPTION_KEY` from 32 random bytes and store it separately from the backup archive set.
5. Keep `SEED_DEMO`, `ENABLE_DEMO_USERS`, `DEMO_PASSWORD`, and `SEED_ADMIN_PASSWORD` unset in production.
6. Leave `ENFORCE_HTTPS` unset or `true`.

## HTTPS and proxying

The default stack is:

`client -> edge nginx -> web nginx -> api`

That means `TRUST_PROXY_HOPS=2`.

If the proxy chain does not preserve `X-Forwarded-Proto=https`, the API rejects normal requests with HTTP `426 HTTPS is required`. That is intentional and makes proxy mistakes visible immediately.

If you prefer automatic certificates, use the provided `deploy\Caddyfile` instead of the `edge` nginx service. With Caddy in front of the bundled `web` nginx, the hop count is still `2`.

## Cookies

In production the session cookie is:

- name: `__Host-pos_session`
- `HttpOnly`
- `Secure`
- `SameSite=Lax`
- scoped to the same host only

This requires HTTPS on the real production hostname. Browsers will not accept the cookie over plain HTTP.

## First deployment

From the repository root in PowerShell:

1. Build images:

   `docker compose --env-file .\deploy\.env.production -f .\deploy\docker-compose.prod.yml build api migrate web`

2. Start PostgreSQL only:

   `docker compose --env-file .\deploy\.env.production -f .\deploy\docker-compose.prod.yml up -d db`

3. Run schema migrations:

   `docker compose --env-file .\deploy\.env.production -f .\deploy\docker-compose.prod.yml run --rm migrate`

4. Start the app stack:

   `docker compose --env-file .\deploy\.env.production -f .\deploy\docker-compose.prod.yml up -d api web edge backup`

5. Create the first admin account:

   `docker compose --env-file .\deploy\.env.production -f .\deploy\docker-compose.prod.yml run --rm api node dist/src/ops/provisionAdmin.js --username owner --generate`

No default accounts are created automatically.

## Migrations

Always take a backup before a deployment that might touch the database:

`docker compose --env-file .\deploy\.env.production -f .\deploy\docker-compose.prod.yml run --rm backup node dist/src/ops/backup.js`

Then apply migrations with:

`docker compose --env-file .\deploy\.env.production -f .\deploy\docker-compose.prod.yml run --rm migrate`

`prisma migrate deploy` is forward-only. If a migration is destructive, rollback means redeploying the previous app image and restoring a backup.

## Upgrades

Recommended sequence:

1. Take a backup.
2. Build or pull the new images.
3. Run `migrate`.
4. Restart `api`, `web`, `edge`, and `backup`.
5. Verify `https://<domain>/health`, `https://<domain>/ready`, sign-in, and a sample sale flow.

## Rollback

### App-only rollback

If the new app image is bad but the schema is still compatible, redeploy a previous image tag:

```powershell
$env:IMAGE_TAG = "previous-tag"
docker compose --env-file .\deploy\.env.production -f .\deploy\docker-compose.prod.yml up -d api web backup
```

### Data rollback

If a migration or bad write must be undone, restore from backup. See [BACKUP-RECOVERY.md](./BACKUP-RECOVERY.md). Typical recovery is: stop writes, restore the database, then redeploy the matching app image tag.

## Monitoring and logs

- `GET /health` = liveness
- `GET /ready` = readiness; it returns `503` when the database is unavailable
- API logs are structured JSON via pino with redaction
- View logs with:

  `docker compose --env-file .\deploy\.env.production -f .\deploy\docker-compose.prod.yml logs api | jq`

- Client-facing API errors include `requestId`; match that value to the `X-Request-Id` response header and the log line
- Suggested alerts:
  - uptime checks on `/health`
  - readiness checks on `/ready`
  - API log alerts for `error` and `fatal` events (or numeric pino level `>= 50` if your log pipeline preserves numeric levels)

## Pre-go-live checklist

- [ ] `deploy\.env.production` contains strong unique secrets and the right domain
- [ ] `TRUST_PROXY_HOPS` matches the actual proxy chain
- [ ] TLS is working end-to-end and API routes do not return 426
- [ ] Backups run, encrypt, retain, and alert correctly
- [ ] An admin account was provisioned manually
- [ ] `/health` and `/ready` are monitored
- [ ] Logs are collected and searchable by `requestId`
- [ ] Restore steps were rehearsed against a non-production copy
- [ ] Printer workflow was verified in the browser on each register

## Sprint 5.1 verification status

**Docker was NOT available on the development machine** (no Docker/Podman, no WSL, no hypervisor), so the following have **not** been verified and must not be treated as passing:

| Item | Status |
|---|---|
| `docker build` of API/web images | NOT VERIFIED |
| `docker compose up` (db, migrate, api, backup, web, edge) | NOT VERIFIED |
| Health/ready/auth/checkout inside containers | NOT VERIFIED |
| Containerised backup + restore | NOT VERIFIED |
| Load test against containers | NOT VERIFIED |

To produce real evidence, run the manual GitHub Actions workflow `.github/workflows/docker-verify.yml` (builds images, starts the stack, checks health, provisions an admin, runs backup + `verifyRestore`), or follow the same steps by hand on any Docker host:

```
cp deploy/.env.production.example deploy/.env.production   # replace every CHANGE_ME_*, set DATABASE_URL password to match POSTGRES_PASSWORD
docker compose --env-file deploy/.env.production -f deploy/docker-compose.prod.yml build
docker compose --env-file deploy/.env.production -f deploy/docker-compose.prod.yml up -d db migrate api backup web
docker compose ... ps                      # api must become "healthy"
docker compose ... run --rm -e ADMIN_PASSWORD=... api node dist/src/ops/provisionAdmin.js --username owner --full-name "Owner"
BASE_URL=http://127.0.0.1:<published port> ADMIN_USER=owner ADMIN_PASSWORD=... npm run loadtest   # from apps/api
```

### Static review findings (fixed)
- `postgres:18-alpine` stores data in a versioned subdirectory; the volume is now mounted at `/var/lib/postgresql` (mounting `/var/lib/postgresql/data` makes PG 18 refuse to start).

### What WAS verified natively (non-Docker, same code)
- Production-mode startup, `/health`, `/ready`, HTTPS enforcement (426), HSTS, cookie flags, config validation: `startup.test.ts`, `production.test.ts`.
- Encrypted backup, tamper detection, retention, restore into an isolated database: `backup.test.ts`.
- Full API, web and e2e suites (see `docs/TASKS.md`).

### Load test results (native, embedded PostgreSQL, `apps/api/scripts/loadtest.ts`)
`npm run loadtest` drives real HTTP sessions (login per cashier, product search, barcode lookup, cash sale, duplicate-id replays) and then asserts invariants: no errors, unique and gap-free invoice numbers, replays return the original invoice, stock = opening - units sold, `/reports/products` units/revenue equal client totals, cash collected includes the run. Env: `BASE_URL`, `ADMIN_USER`, `ADMIN_PASSWORD`, `CASHIERS`, `SALES_PER_CASHIER`, `PRODUCTS`, `THINK_MS`.

| Scenario | Sales | Throughput | Sale p50 / p95 / p99 | Invariants |
|---|---|---|---|---|
| 5 cashiers, paced 1.5 s think time, production rate limits | 200 | 2.9/s | 38 / 63 / 82 ms | all pass |
| 5 cashiers unpaced, 40 products | 1000 | 79.5/s | 38 / 62 / 92 ms | all pass |
| 10 cashiers unpaced, 3 hot products (row contention) | 2000 | 63.5/s | 83 / 342 / 570 ms (max 2.0 s) | all pass |

Expected volume is 200-500 sales/day, so this is orders of magnitude of headroom. Numbers are from a laptop with a local database, not the container stack or a network; treat them as a baseline, not a production SLA.

**Rate-limit finding:** unpaced runs under production limits hit the general limiter (1200 req/min per IP) and returned 429 - correct behaviour, and invoice numbering/idempotency still held. All registers behind one store NAT share one IP bucket; a real cashier makes roughly 70 req/min, so 5 registers fit, but raise `API_RATE_LIMIT_MAX` if you add registers or heavy reporting.

**Tooling note:** Node 26's built-in `fetch` stalled 20-60 s on reused keep-alive sockets on this Windows host (reproduced against a bare `http.createServer`; not an API issue), so the load client uses `node:http`.

## Troubleshooting
- API container unhealthy: `docker compose ... logs api`; startup config errors list the offending variables (production refuses demo flags, non-HTTPS CORS origins, weak secrets).
- `migrate` exits non-zero: check `DATABASE_URL` password matches `POSTGRES_PASSWORD`; the API will not start until migrate succeeds.
- Postgres container restarts on PG 18 with a "data directory" message: volume must be mounted at `/var/lib/postgresql`.
- Login returns 426/redirect loops: proxy not sending `X-Forwarded-Proto: https` or `TRUST_PROXY_HOPS` wrong (edge -> web -> api = 2).
- Many 429s: see the rate-limit note above.
- In the production image run ops tools as `node dist/src/ops/<name>.js` (tsx is not installed there).

## Rollback
Set `IMAGE_TAG` to the previous tag and `docker compose ... up -d api web`. Migrations are forward-only; if a migration must be undone, restore the pre-upgrade backup (take one immediately before every upgrade: `node dist/src/ops/backup.js`) per `docs/BACKUP-RECOVERY.md`.

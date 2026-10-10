# Backup & Recovery

All commands run from `apps/api`. In the production image use `node dist/src/ops/<name>.js` instead of `npm run <script>` (the image ships compiled JavaScript and `postgresql-client-18`).

## What is backed up
A full `pg_dump -Fc` of the application database, encrypted with **AES-256-GCM** before it touches disk. File layout: `POSBK1` magic + IV + ciphertext + auth tag. Beside each `*.dump.enc` is `*.manifest.json` (sha256 of the file, timestamp, and a fingerprint of row counts plus the sum of sale totals). `last-backup.json` records the latest result for alerting.

## Configuration
| Variable | Default | Purpose |
|---|---|---|
| `BACKUP_DIR` | `./backups` | Where encrypted dumps are written (mount a separate volume or sync it off-host) |
| `BACKUP_ENCRYPTION_KEY` | required | base64 of 32 random bytes. **Store it separately from the backups** (password manager / secret store). Without it a backup is unrecoverable. |
| `BACKUP_RETENTION_DAYS` | 30 | Backups older than this are deleted... |
| `BACKUP_MIN_KEEP` | 7 | ...but the newest N are always kept |
| `BACKUP_HOUR` | 2 | Hour (server local time) the scheduler runs daily |
| `BACKUP_MAX_AGE_HOURS` | 26 | `backup:check` alerts if the newest backup is older |
| `ALERT_WEBHOOK_URL` | unset | Slack/Teams/generic JSON webhook that receives `{ "text": ... }` on failure or staleness |
| `PG_DUMP_PATH`, `PG_RESTORE_PATH`, `PSQL_PATH` | on `PATH` | Override tool locations (Windows) |

Generate a key: `npm run backup -- --generate-key`.

## Operations
| Task | Command |
|---|---|
| Backup now | `npm run backup` |
| Daily scheduler (long-running; the compose `backup` service runs this) | `npm run backup:schedule` |
| Freshness check (exit 1 + webhook if stale/failed). Run from cron / monitoring every hour | `npm run backup:check` |
| Verify newest backup restores correctly | `npm run restore:verify` |
| Restore into a database | `npm run restore -- --file <x.dump.enc> --target-url postgres://...` |

Backup failures and stale backups send the webhook alert and write an `error`-level structured log line (`"level":"error"`), which log-based alerting can also match.

Decryption checks the GCM tag first, so a tampered file or wrong key fails loudly and never reaches `pg_restore`.

## Recovery test (`restore:verify`)
Restores the backup into a throw-away database on the same server, compares per-table row counts and the sale-total sum with the manifest, then drops the scratch database. Run it after any change to the schema or backup tooling and at least monthly.

Evidence: `apps/api/tests/backup.test.ts` takes a real encrypted backup of a populated database with PostgreSQL 18 client tools and restores it into an isolated database; counts and sale totals match, tampered and wrong-key files are rejected, retention prunes correctly, and webhook alerts fire for failed and stale backups. The test is skipped if the pg tools are not found (`PG_TOOLS_DIR`).

## Disaster recovery procedure
1. **Stop writes.** `docker compose ... stop api web` (or take the site offline at the proxy).
2. **Provision a clean PostgreSQL** (new volume, or a new empty database). Never restore over the damaged database in place unless you have a copy of it.
3. **Fetch** the newest good `*.dump.enc` and retrieve `BACKUP_ENCRYPTION_KEY` from the secret store.
4. **Verify**: `npm run restore:verify -- --file <file>` (against the new server). Stop if it fails; try the previous backup.
5. **Restore**: `npm run restore -- --file <file> --target-url <new database URL>`. The tool refuses to target the live `DATABASE_URL` unless `--i-understand-this-overwrites-production` is passed.
6. **Apply newer migrations**: `npm run migrate:deploy` (a no-op if the backup is current).
7. **Point the API** at the restored database (`DATABASE_URL`), start it, and confirm `/ready` returns 200.
8. **Validate**: log in, open the latest sale, and check the Reports totals against the last known figures.
9. **Reconcile the gap.** Sales made between the backup and the failure are lost; list them from receipts/terminals and record the incident. Recovery point = last backup (up to 24 h with the daily schedule; run the scheduler more often or add WAL archiving if that is too long). Recovery time depends on database size; the current dataset restores in seconds.

## Migration deployment
1. Take a fresh backup: `npm run backup`; confirm with `npm run restore:verify`.
2. Deploy the new image.
3. `npm run migrate:deploy` (compose: `docker compose ... run --rm migrate`). It is forward-only and idempotent.
4. Check `/ready`, then smoke-test checkout.
5. **Rollback:** redeploy the previous image tag. If a migration must be undone, restore the pre-migration backup into a new database (procedure above) rather than hand-editing the schema.

See [DEPLOYMENT.md](./DEPLOYMENT.md) for the container, proxy and rollback steps.

## Sprint 5.1: WAL archiving and point-in-time recovery (evaluation)

Status: **evaluated, not implemented or tested** (no Docker/WSL available; a PITR drill needs a real server).

Current protection is a scheduled encrypted logical dump (`pg_dump`): worst-case data loss (RPO) equals the backup interval (default daily, up to ~24 h of sales). Restore of the dump was verified into an isolated database natively (`restore:verify`, `backup.test.ts`); containerised restore is NOT VERIFIED.

PITR options:
1. **Self-managed WAL archiving**: `archive_mode=on`, `archive_command` shipping segments to encrypted off-host storage, plus periodic physical base backups; recover with `restore_command` and `recovery_target_time`. RPO drops to seconds (or `archive_timeout`, e.g. 60 s). Use pgBackRest or WAL-G rather than hand-rolled scripts (retention, encryption, verification). Costs: extra storage, operational complexity, must be drill-tested, and the Docker image/volume layout must change (archive volume or object storage, base-backup job).
2. **Managed PostgreSQL with built-in PITR** (cloud provider): same RPO with far less operational risk; usually the better choice for a single-store business without a DBA.
3. Keep logical dumps as a portable second layer in either case.

**Recommendation:** before go-live, adopt option 2, or option 1 with pgBackRest; keep the encrypted daily dump regardless. If neither is adopted, state the ~24 h RPO to the business and consider running the dump hourly (retention config supports it). Whichever is chosen, a timed restore drill to a chosen timestamp must be recorded here before launch.

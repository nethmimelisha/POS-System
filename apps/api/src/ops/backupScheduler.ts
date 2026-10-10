import { runBackupJob, checkBackupFreshness } from "./backupLib.js";

// Runs one backup per day at BACKUP_HOUR (server local time, default 02) and re-checks freshness hourly.
const hour = Number(process.env.BACKUP_HOUR ?? 2);
let lastRunDay = "";

async function tick() {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  if (now.getHours() >= hour && lastRunDay !== day) {
    lastRunDay = day;
    await runBackupJob();
  }
}

console.log(`[backup-scheduler] daily backup at ${String(hour).padStart(2, "0")}:00`);
void tick();
setInterval(() => void tick(), 60_000);
setInterval(() => void checkBackupFreshness(), 3_600_000);
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => process.exit(0));
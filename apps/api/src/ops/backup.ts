import { runBackupJob, generateKey } from "./backupLib.js";

if (process.argv.includes("--generate-key")) {
  console.log(generateKey());
} else {
  const r = await runBackupJob();
  process.exit(r.ok ? 0 : 1);
}
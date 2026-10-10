import { checkBackupFreshness } from "./backupLib.js";

const r = await checkBackupFreshness();
console.log(r.ok ? "backup is fresh" : `backup problem: ${r.reason}`);
process.exit(r.ok ? 0 : 1);
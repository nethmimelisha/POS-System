import { restoreBackup, targetsLiveDatabase } from "./backupLib.js";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const file = arg("file");
const targetUrl = arg("target-url") ?? process.env.RESTORE_DATABASE_URL;
if (!file || !targetUrl) {
  console.error("Usage: restore --file <backup.dump.enc> --target-url <postgres url> [--clean] [--i-understand-this-overwrites-production]");
  process.exit(2);
}
if (targetsLiveDatabase(targetUrl) && !process.argv.includes("--i-understand-this-overwrites-production")) {
  console.error("Refusing: target is the live DATABASE_URL. Restore into a new database, or pass --i-understand-this-overwrites-production.");
  process.exit(2);
}
await restoreBackup({ file, targetUrl, clean: process.argv.includes("--clean") });
console.log("restore complete");
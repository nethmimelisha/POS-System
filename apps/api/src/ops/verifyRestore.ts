import { listBackups, verifyRestore } from "./backupLib.js";

const i = process.argv.indexOf("--file");
const file = i >= 0 ? process.argv[i + 1] : (await listBackups())[0]?.file;
if (!file) {
  console.error("No backup found");
  process.exit(2);
}
const r = await verifyRestore(file);
console.log(JSON.stringify(r, null, 2));
process.exit(r.ok ? 0 : 1);
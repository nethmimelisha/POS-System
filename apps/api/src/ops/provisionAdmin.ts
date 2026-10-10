/**
 * Creates the first administrator of a production system.
 *
 *   npm run provision:admin -- --username owner --full-name "Store Owner"
 *
 * Password: from ADMIN_PASSWORD, or typed at a hidden prompt, or (with --generate) a random one printed once.
 * Nothing here ever uses a default password. Refuses to run when an administrator already exists
 * unless --allow-additional is given.
 */
import crypto from "node:crypto";
import readline from "node:readline";
import bcrypt from "bcryptjs";
import { prisma } from "../db.js";
import { KNOWN_DEFAULT_PASSWORDS } from "./demoGuard.js";

export function validatePassword(password: string, username: string): string[] {
  const problems: string[] = [];
  if (password.length < 12) problems.push("must be at least 12 characters");
  if (password.length > 128) problems.push("must be at most 128 characters");
  if (KNOWN_DEFAULT_PASSWORDS.some((d) => d.toLowerCase() === password.toLowerCase())) problems.push("is a well-known default password");
  if (username && password.toLowerCase().includes(username.toLowerCase())) problems.push("must not contain the username");
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  if (classes < 3) problems.push("must mix at least three of: lowercase, uppercase, digits, symbols");
  return problems;
}

export function generatePassword(length = 20): string {
  const sets = ["abcdefghjkmnpqrstuvwxyz", "ABCDEFGHJKMNPQRSTUVWXYZ", "23456789", "!#$%*+-=?@^_"];
  const all = sets.join("");
  const pick = (chars: string) => chars[crypto.randomInt(chars.length)];
  const out = sets.map(pick);
  while (out.length < length) out.push(pick(all));
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join("");
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const w = rl as unknown as { _writeToOutput: (s: string) => void };
    w._writeToOutput = (s: string) => {
      if (s.includes(question)) process.stdout.write(s);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

export async function provisionAdmin(opts: { username: string; fullName: string; password: string; allowAdditional?: boolean }) {
  const { username, fullName, password } = opts;
  if (!/^[a-z0-9._-]{3,40}$/i.test(username)) throw new Error("Username must be 3-40 characters: letters, digits, . _ -");
  const problems = validatePassword(password, username);
  if (problems.length) throw new Error(`Password ${problems.join("; ")}`);
  const admins = await prisma.user.count({ where: { role: "ADMIN", isActive: true } });
  if (admins > 0 && !opts.allowAdditional) throw new Error("An administrator already exists. Pass --allow-additional to create another.");
  if (await prisma.user.findUnique({ where: { username } })) throw new Error(`User "${username}" already exists`);
  const user = await prisma.user.create({
    data: { username, fullName, role: "ADMIN", passwordHash: await bcrypt.hash(password, 12) },
  });
  await prisma.auditLog.create({ data: { userId: user.id, action: "admin.provisioned", entityType: "User", entityId: user.id } });
  return user;
}

async function main() {
  const username = arg("username") ?? "owner";
  const fullName = arg("full-name") ?? "Store Owner";
  const generated = process.argv.includes("--generate");
  let password = process.env.ADMIN_PASSWORD ?? "";
  if (generated) password = generatePassword();
  else if (!password) {
    password = await promptHidden("New administrator password: ");
    if (password !== (await promptHidden("Repeat password: "))) throw new Error("Passwords do not match");
  }
  const user = await provisionAdmin({ username, fullName, password, allowAdditional: process.argv.includes("--allow-additional") });
  console.log(`Administrator "${user.username}" created.`);
  if (generated) console.log(`Generated password (shown once, store it in your password manager): ${password}`);
}

if (process.argv[1] && /provisionAdmin\.[jt]s$/.test(process.argv[1])) {
  main()
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
import bcrypt from "bcryptjs";
import { prisma } from "../db.js";

// Passwords that ship in docs, seeds and examples. If any account still uses one, production must not start.
export const KNOWN_DEFAULT_PASSWORDS = ["Admin12345!", "Demo12345!", "ChangeMe123!", "TestPass123!", "SprintFour123!", "admin", "password"];
const DEMO_USERNAMES = ["admin", "manager", "cashier"];

/** Returns the usernames that still accept a published default password. Production startup refuses to proceed if any exist. */
export async function findDefaultCredentials(): Promise<string[]> {
  const users = await prisma.user.findMany({ where: { username: { in: DEMO_USERNAMES }, isActive: true }, select: { username: true, passwordHash: true } });
  const found: string[] = [];
  for (const u of users) {
    for (const pw of KNOWN_DEFAULT_PASSWORDS) {
      if (await bcrypt.compare(pw, u.passwordHash)) {
        found.push(u.username);
        break;
      }
    }
  }
  return found;
}

const SAMPLE_SKUS = ["RICE-1KG", "DHAL-500", "OIL-750", "TEA-200", "BOOK-80", "WATER-1L"];

/** Demo catalog rows are a second sign that demo seeding ran against this database. */
export async function hasDemoCatalog(): Promise<boolean> {
  return (await prisma.productVariant.count({ where: { sku: { in: SAMPLE_SKUS } } })) >= 3;
}
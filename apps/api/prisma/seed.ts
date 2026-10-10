import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  await prisma.businessSettings.upsert({ where: { id: 1 }, create: {}, update: {} });

  for (const [code, name, isCash] of [
    ["cash", "Cash", true],
    ["card", "Card", false],
    ["online", "Online Transfer / Wallet", false],
  ] as const) {
    await prisma.paymentMethod.upsert({ where: { code }, create: { code, name, isCash }, update: {} });
  }

  // Sri Lanka VAT: standard 18% (verify against current IRD rate before enabling), plus zero-rated and exempt.
  for (const t of [
    { name: "VAT 18%", type: "STANDARD", ratePct: 18 },
    { name: "Zero-rated", type: "ZERO_RATED", ratePct: 0 },
    { name: "VAT Exempt", type: "EXEMPT", ratePct: 0 },
  ] as const) {
    await prisma.taxRate.upsert({ where: { name: t.name }, create: t, update: {} });
  }

  // Used only to settle exchanges. Inactive so it cannot be picked as a payment or refund method.
  await prisma.paymentMethod.upsert({ where: { code: "exchange_credit" }, create: { code: "exchange_credit", name: "Exchange credit", isActive: false, isSystem: true }, update: {} });

  for (const name of ["Register 1", "Register 2"]) {
    await prisma.register.upsert({ where: { name }, create: { name }, update: {} });
  }

  // Reference data above is safe everywhere. Accounts are not: production administrators are created
  // only by `npm run provision:admin`, which never uses a default or shared password.
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (process.env.NODE_ENV === "production") {
    if (password) throw new Error("SEED_ADMIN_PASSWORD is not allowed in production. Use `npm run provision:admin`.");
    console.log("Reference data seeded. No user accounts were created; run `npm run provision:admin`.");
    return;
  }
  if (!password) {
    console.log("Reference data seeded. Set SEED_ADMIN_PASSWORD to also create a development admin.");
    return;
  }
  const username = process.env.SEED_ADMIN_USERNAME ?? "admin";
  const existing = await prisma.user.findUnique({ where: { username } });
  if (!existing) {
    await prisma.user.create({
      data: { username, fullName: "Administrator", role: "ADMIN", passwordHash: await bcrypt.hash(password, 10) },
    });
    console.log(`Created development admin "${username}".`);
  }
}
main().finally(() => prisma.$disconnect());

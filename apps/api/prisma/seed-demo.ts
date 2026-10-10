import bcrypt from "bcryptjs";
import type { PrismaClient } from "@prisma/client";

export const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "Demo12345!";

const products = [
  { name: "Basmati Rice 1kg", sku: "RICE-1KG", barcode: "4791000000011", price: 450, cost: 380, stock: 50, reorder: 10, unit: "pack" },
  { name: "Red Lentils 500g", sku: "DHAL-500", barcode: "4791000000028", price: 320, cost: 260, stock: 40, reorder: 10, unit: "pack" },
  { name: "Coconut Oil 750ml", sku: "OIL-750", barcode: "4791000000035", price: 1250, cost: 1000, stock: 25, reorder: 5, unit: "bottle" },
  { name: "Ceylon Tea 200g", sku: "TEA-200", barcode: "4791000000042", price: 780, cost: 600, stock: 30, reorder: 8, unit: "pack" },
  { name: "Exercise Book 80pg", sku: "BOOK-80", barcode: "4791000000059", price: 180, cost: 120, stock: 3, reorder: 5, unit: "pcs" },
  { name: "Bottled Water 1L", sku: "WATER-1L", barcode: "4791000000066", price: 100, cost: 60, stock: 200, reorder: 24, unit: "bottle" },
];

/** Demo users and catalog for local development and end-to-end tests. Never run against production. */
export async function seedDemo(prisma: PrismaClient) {
  if (process.env.NODE_ENV === "production") throw new Error("Demo data cannot be seeded in production");
  for (const [username, fullName, role] of [
    ["manager", "Demo Manager", "MANAGER"],
    ["cashier", "Demo Cashier", "CASHIER"],
  ] as const) {
    await prisma.user.upsert({
      where: { username },
      create: { username, fullName, role, passwordHash: await bcrypt.hash(DEMO_PASSWORD, 10) },
      update: {},
    });
  }
  const category =
    (await prisma.category.findFirst({ where: { name: "Groceries", parentId: null } })) ??
    (await prisma.category.create({ data: { name: "Groceries" } }));

  for (const p of products) {
    if (await prisma.productVariant.findUnique({ where: { sku: p.sku } })) continue;
    const product = await prisma.product.create({
      data: {
        name: p.name,
        unit: p.unit,
        categoryId: category.id,
        variants: {
          create: {
            sku: p.sku,
            costPrice: p.cost,
            sellPrice: p.price,
            reorderLevel: p.reorder,
            barcodes: { create: { barcode: p.barcode } },
          },
        },
      },
      include: { variants: true },
    });
    const variantId = product.variants[0].id;
    await prisma.stockLevel.create({ data: { variantId, onHand: p.stock } });
    await prisma.stockMovement.create({
      data: { variantId, type: "OPENING", quantity: p.stock, unitCost: p.cost, reason: "Demo data" },
    });
  }
}

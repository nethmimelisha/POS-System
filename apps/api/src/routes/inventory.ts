import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db.js";
import { asyncHandler } from "../middleware/error.js";
import { requireRole } from "../middleware/auth.js";
import { audit } from "../services/audit.js";
import { getSettings, recordMovement } from "../services/stock.js";

export const inventoryRouter = Router();

inventoryRouter.get(
  "/levels",
  asyncHandler(async (req, res) => {
    const { lowOnly } = z.object({ lowOnly: z.enum(["true", "false"]).optional() }).parse(req.query);
    if (lowOnly === "true") {
      const rows = await prisma.$queryRaw<unknown[]>(Prisma.sql`
        SELECT v.id AS "variantId", v.sku, p.name AS "productName", v.name AS "variantName",
               v."reorderLevel", COALESCE(s."onHand", 0) AS "onHand"
        FROM "ProductVariant" v
        JOIN "Product" p ON p.id = v."productId"
        LEFT JOIN "StockLevel" s ON s."variantId" = v.id
        WHERE v."isActive" AND p."isActive" AND p."trackStock" AND COALESCE(s."onHand", 0) <= v."reorderLevel"
        ORDER BY p.name, v.sku`);
      return res.json(rows);
    }
    res.json(await prisma.stockLevel.findMany({ include: { variant: { include: { product: true } } } }));
  }),
);

const adjustSchema = z.object({
  variantId: z.string().uuid(),
  type: z.enum(["ADJUSTMENT", "DAMAGE", "PURCHASE"]),
  quantity: z.number().refine((n) => n !== 0, "Quantity cannot be zero"),
  unitCost: z.number().min(0).optional(),
  reason: z.string().min(1).max(300),
});

inventoryRouter.post(
  "/adjustments",
  requireRole("ADMIN", "MANAGER"),
  asyncHandler(async (req, res) => {
    const input = adjustSchema.parse(req.body);
    const settings = await getSettings();
    // Damage always removes stock; purchases always add it.
    const quantity =
      input.type === "DAMAGE" ? -Math.abs(input.quantity) : input.type === "PURCHASE" ? Math.abs(input.quantity) : input.quantity;
    const movement = await prisma.$transaction((tx) =>
      recordMovement(tx, { ...input, quantity, userId: req.user!.id }, settings.allowNegativeStock),
    );
    await audit(req, "stock.adjust", "ProductVariant", input.variantId, {
      type: input.type,
      quantity,
      reason: input.reason,
    });
    const level = await prisma.stockLevel.findUniqueOrThrow({ where: { variantId: input.variantId } });
    res.status(201).json({ movementId: movement.id.toString(), onHand: level.onHand });
  }),
);

inventoryRouter.get(
  "/movements",
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        variantId: z.string().uuid().optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(req.query);
    const rows = await prisma.stockMovement.findMany({
      where: q.variantId ? { variantId: q.variantId } : {},
      orderBy: { id: "desc" },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    });
    res.json(rows.map((r) => ({ ...r, id: r.id.toString() })));
  }),
);

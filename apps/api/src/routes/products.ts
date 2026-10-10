import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db.js";
import { asyncHandler, HttpError } from "../middleware/error.js";
import { requireRole } from "../middleware/auth.js";
import { audit } from "../services/audit.js";
import { getSettings, recordMovement } from "../services/stock.js";

export const productsRouter = Router();
const managerUp = requireRole("ADMIN", "MANAGER");

const money = z.number().min(0).max(99_999_999.99);
const qty = z.number().min(0).max(999_999_999);

const variantInput = z.object({
  sku: z.string().min(1).max(64),
  name: z.string().max(100).nullable().optional(),
  costPrice: money.default(0),
  sellPrice: money,
  reorderLevel: qty.default(0),
  barcodes: z.array(z.string().min(1).max(64)).default([]),
  openingStock: qty.optional(),
});

const productInput = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  categoryId: z.number().int().nullable().optional(),
  brandId: z.number().int().nullable().optional(),
  taxRateId: z.number().int().nullable().optional(),
  unit: z.string().min(1).max(20).default("pcs"),
  imageUrl: z.string().url().nullable().optional(),
  trackStock: z.boolean().default(true),
  variants: z.array(variantInput).min(1),
});

const include = {
  category: true,
  brand: true,
  taxRate: true,
  variants: { include: { barcodes: true, stockLevel: true }, orderBy: { sku: "asc" } },
} satisfies Prisma.ProductInclude;

productsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        search: z.string().trim().optional(),
        categoryId: z.coerce.number().int().optional(),
        active: z.enum(["true", "false"]).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
      })
      .parse(req.query);

    const where: Prisma.ProductWhereInput = {
      ...(q.categoryId ? { categoryId: q.categoryId } : {}),
      ...(q.active ? { isActive: q.active === "true" } : {}),
      ...(q.search
        ? {
            OR: [
              { name: { contains: q.search, mode: "insensitive" } },
              { variants: { some: { sku: { contains: q.search, mode: "insensitive" } } } },
              { variants: { some: { barcodes: { some: { barcode: q.search } } } } },
            ],
          }
        : {}),
    };
    const [total, items] = await prisma.$transaction([
      prisma.product.count({ where }),
      prisma.product.findMany({
        where,
        include,
        orderBy: { name: "asc" },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    res.json({ total, page: q.page, pageSize: q.pageSize, items });
  }),
);

// Exact barcode or SKU match, used by the scanner at checkout.
productsRouter.get(
  "/lookup/:code",
  asyncHandler(async (req, res) => {
    const code = String(req.params.code);
    const variant = await prisma.productVariant.findFirst({
      where: { isActive: true, product: { isActive: true }, OR: [{ sku: code }, { barcodes: { some: { barcode: code } } }] },
      include: { product: { include: { taxRate: true } }, barcodes: true, stockLevel: true },
    });
    if (!variant) throw new HttpError(404, "No product matches this code");
    res.json(variant);
  }),
);

productsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const product = await prisma.product.findUnique({ where: { id: String(req.params.id) }, include });
    if (!product) throw new HttpError(404, "Product not found");
    res.json(product);
  }),
);

productsRouter.post(
  "/",
  managerUp,
  asyncHandler(async (req, res) => {
    const { variants, ...data } = productInput.parse(req.body);
    const settings = await getSettings();

    const id = await prisma.$transaction(async (tx) => {
      const product = await tx.product.create({ data });
      for (const v of variants) {
        const { barcodes, openingStock, ...vd } = v;
        const variant = await tx.productVariant.create({
          data: { ...vd, productId: product.id, barcodes: { create: barcodes.map((barcode) => ({ barcode })) } },
        });
        if (openingStock && openingStock > 0) {
          await recordMovement(
            tx,
            { variantId: variant.id, type: "OPENING", quantity: openingStock, unitCost: v.costPrice, userId: req.user!.id },
            settings.allowNegativeStock,
          );
        }
      }
      return product.id;
    });
    await audit(req, "product.create", "Product", id, { name: data.name });
    res.status(201).json(await prisma.product.findUniqueOrThrow({ where: { id }, include }));
  }),
);

const productUpdate = productInput.omit({ variants: true }).partial().extend({ isActive: z.boolean().optional() });

productsRouter.patch(
  "/:id",
  managerUp,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const product = await prisma.product.update({
      where: { id },
      data: productUpdate.parse(req.body),
      include,
    });
    await audit(req, "product.update", "Product", id, { fields: Object.keys(req.body) });
    res.json(product);
  }),
);

productsRouter.post(
  "/:id/variants",
  managerUp,
  asyncHandler(async (req, res) => {
    const { barcodes, openingStock, ...vd } = variantInput.parse(req.body);
    const productId = String(req.params.id);
    const settings = await getSettings();
    const variant = await prisma.$transaction(async (tx) => {
      const created = await tx.productVariant.create({
        data: { ...vd, productId, barcodes: { create: barcodes.map((barcode) => ({ barcode })) } },
      });
      if (openingStock && openingStock > 0) {
        await recordMovement(
          tx,
          { variantId: created.id, type: "OPENING", quantity: openingStock, unitCost: vd.costPrice, userId: req.user!.id },
          settings.allowNegativeStock,
        );
      }
      return created;
    });
    await audit(req, "variant.create", "ProductVariant", variant.id);
    res.status(201).json(variant);
  }),
);

const variantUpdate = z
  .object({
    sku: z.string().min(1).max(64),
    name: z.string().max(100).nullable(),
    costPrice: money,
    sellPrice: money,
    reorderLevel: qty,
    isActive: z.boolean(),
    barcodes: z.array(z.string().min(1).max(64)),
  })
  .partial();

productsRouter.patch(
  "/variants/:variantId",
  managerUp,
  asyncHandler(async (req, res) => {
    const variantId = String(req.params.variantId);
    const { barcodes, ...data } = variantUpdate.parse(req.body);
    const before = await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } });
    const variant = await prisma.$transaction(async (tx) => {
      if (barcodes) {
        await tx.variantBarcode.deleteMany({ where: { variantId } });
        await tx.variantBarcode.createMany({ data: [...new Set(barcodes.map((b) => b.trim()).filter(Boolean))].map((barcode) => ({ barcode, variantId })) });
      }
      return tx.productVariant.update({ where: { id: variantId }, data, include: { barcodes: true } });
    });
    if (data.sellPrice !== undefined || data.costPrice !== undefined) {
      await audit(req, "price.change", "ProductVariant", variantId, {
        sellPrice: [before.sellPrice.toString(), variant.sellPrice.toString()],
        costPrice: [before.costPrice.toString(), variant.costPrice.toString()],
      });
    }
    await audit(req, "variant.update", "ProductVariant", variantId, { fields: Object.keys(req.body ?? {}) });
    res.json(variant);
  }),
);

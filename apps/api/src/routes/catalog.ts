import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { asyncHandler, HttpError } from "../middleware/error.js";
import { requireRole } from "../middleware/auth.js";
import { audit } from "../services/audit.js";
import { getSettings } from "../services/stock.js";

const managerUp = requireRole("ADMIN", "MANAGER");

// ---------- Tax rates ----------
export const taxRatesRouter = Router();

const taxSchema = z
  .object({
    name: z.string().min(1).max(50),
    type: z.enum(["STANDARD", "ZERO_RATED", "EXEMPT"]),
    ratePct: z.number().min(0).max(100),
    isActive: z.boolean(),
  })
  .partial({ isActive: true })
  .refine((v) => v.type === "STANDARD" || v.ratePct === 0, {
    message: "Zero-rated and exempt taxes must have a 0% rate",
  });

taxRatesRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json(await prisma.taxRate.findMany({ orderBy: { name: "asc" } }));
  }),
);
taxRatesRouter.post(
  "/",
  managerUp,
  asyncHandler(async (req, res) => {
    const rate = await prisma.taxRate.create({ data: taxSchema.parse(req.body) as any });
    await audit(req, "taxrate.create", "TaxRate", String(rate.id));
    res.status(201).json(rate);
  }),
);
taxRatesRouter.put(
  "/:id",
  managerUp,
  asyncHandler(async (req, res) => {
    const rate = await prisma.taxRate.update({
      where: { id: Number(req.params.id) },
      data: taxSchema.parse(req.body) as any,
    });
    await audit(req, "taxrate.update", "TaxRate", String(rate.id));
    res.json(rate);
  }),
);

// ---------- Categories ----------
export const categoriesRouter = Router();

const categorySchema = z.object({
  name: z.string().min(1).max(100),
  parentId: z.number().int().nullable().optional(),
  isActive: z.boolean().optional(),
});

categoriesRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json(await prisma.category.findMany({ orderBy: { name: "asc" } }));
  }),
);
categoriesRouter.post(
  "/",
  managerUp,
  asyncHandler(async (req, res) => {
    const data = categorySchema.parse(req.body);
    // The DB unique index does not treat NULL parents as equal, so check root names here.
    if (!data.parentId) {
      const dup = await prisma.category.findFirst({ where: { name: data.name, parentId: null } });
      if (dup) throw new HttpError(409, "Category already exists");
    }
    res.status(201).json(await prisma.category.create({ data }));
  }),
);
categoriesRouter.put(
  "/:id",
  managerUp,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const data = categorySchema.parse(req.body);
    if (data.parentId === id) throw new HttpError(400, "A category cannot be its own parent");
    res.json(await prisma.category.update({ where: { id }, data }));
  }),
);

// ---------- Brands ----------
export const brandsRouter = Router();
const brandSchema = z.object({ name: z.string().min(1).max(100) });

brandsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json(await prisma.brand.findMany({ orderBy: { name: "asc" } }));
  }),
);
brandsRouter.post(
  "/",
  managerUp,
  asyncHandler(async (req, res) => {
    res.status(201).json(await prisma.brand.create({ data: brandSchema.parse(req.body) }));
  }),
);

// ---------- Settings ----------
export const settingsRouter = Router();
const settingsSchema = z
  .object({
    name: z.string().min(1).max(100),
    address: z.string().max(300).nullable(),
    phone: z.string().max(30).nullable(),
    vatNumber: z.string().max(50).nullable(),
    taxEnabled: z.boolean(),
    pricesIncludeTax: z.boolean(),
    allowNegativeStock: z.boolean(),
    requireShift: z.boolean(),
    timezone: z.string().refine((tz) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, "Unknown timezone"),
    receiptHeader: z.string().max(500).nullable(),
    receiptFooter: z.string().max(500).nullable(),
  })
  .partial();

settingsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json(await getSettings());
  }),
);
settingsRouter.put(
  "/",
  requireRole("ADMIN"),
  asyncHandler(async (req, res) => {
    const data = settingsSchema.parse(req.body);
    const settings = await prisma.businessSettings.upsert({ where: { id: 1 }, create: data, update: data });
    await audit(req, "settings.update", "BusinessSettings", "1", data);
    res.json(settings);
  }),
);

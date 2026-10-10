import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db.js";
import { asyncHandler, HttpError } from "../middleware/error.js";
import { requireRole } from "../middleware/auth.js";
import { audit } from "../services/audit.js";

// Customers are optional on a sale: walk-in sales simply carry no customerId.
export const customersRouter = Router();
const managerUp = requireRole("ADMIN", "MANAGER");

const phone = z
  .string()
  .trim()
  .regex(/^[0-9+()\-\s]{6,20}$/, "Enter a valid phone number");

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    phone: phone.nullish().transform((v) => v || null),
    email: z.string().trim().email().max(120).nullish().transform((v) => v || null),
    notes: z.string().trim().max(500).nullish().transform((v) => v || null),
  })
  .strict();
const updateSchema = createSchema.partial();

const idParam = (req: import("express").Request) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) throw new HttpError(404, "Customer not found");
  return id.data;
};

customersRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        search: z.string().trim().max(60).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
      })
      .parse(req.query);
    const where: Prisma.CustomerWhereInput = q.search
      ? {
          OR: [
            { name: { contains: q.search, mode: "insensitive" } },
            { phone: { contains: q.search } },
            { email: { contains: q.search, mode: "insensitive" } },
          ],
        }
      : {};
    const [total, items] = await prisma.$transaction([
      prisma.customer.count({ where }),
      prisma.customer.findMany({ where, orderBy: { name: "asc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    res.json({ total, page: q.page, pageSize: q.pageSize, items });
  }),
);

customersRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const data = createSchema.parse(req.body);
    const customer = await prisma.customer.create({ data });
    await audit(req, "customer.create", "Customer", customer.id, { name: customer.name });
    res.status(201).json(customer);
  }),
);

// Purchase history includes other staff's sales and lifetime spend, so it is manager-only.
customersRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const customer = await prisma.customer.findUnique({ where: { id: idParam(req) } });
    if (!customer) throw new HttpError(404, "Customer not found");
    res.json(customer);
  }),
);

customersRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const data = updateSchema.parse(req.body);
    const customer = await prisma.customer.update({ where: { id }, data });
    await audit(req, "customer.update", "Customer", id, { fields: Object.keys(data) });
    res.json(customer);
  }),
);

customersRouter.get(
  "/:id/history",
  managerUp,
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const q = z
      .object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) })
      .parse(req.query);
    const customer = await prisma.customer.findUnique({ where: { id } });
    if (!customer) throw new HttpError(404, "Customer not found");

    const [totals] = await prisma.$queryRaw<{ purchases: bigint; spent: string; last: Date | null }[]>`
      SELECT COUNT(*) AS purchases, COALESCE(SUM("grandTotal"), 0)::text AS spent, MAX("createdAt") AS last
      FROM "Sale" WHERE "customerId" = ${id} AND status = 'COMPLETED'`;
    const [refunded] = await prisma.$queryRaw<{ refunded: string }[]>`
      SELECT COALESCE(SUM("refundTotal"), 0)::text AS refunded FROM "SaleReturn" WHERE "customerId" = ${id}`;

    const where = { customerId: id };
    const [total, sales] = await prisma.$transaction([
      prisma.sale.count({ where }),
      prisma.sale.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        select: {
          id: true,
          saleNumber: true,
          status: true,
          grandTotal: true,
          createdAt: true,
          cashier: { select: { fullName: true } },
          _count: { select: { items: true } },
          returns: { select: { returnNumber: true, refundTotal: true } },
        },
      }),
    ]);
    const spent = new Prisma.Decimal(totals.spent);
    res.json({
      customer,
      summary: {
        purchases: Number(totals.purchases),
        totalSpent: spent.toFixed(2),
        totalRefunded: new Prisma.Decimal(refunded.refunded).toFixed(2),
        netSpent: spent.minus(refunded.refunded).toFixed(2),
        lastPurchaseAt: totals.last,
      },
      total,
      page: q.page,
      pageSize: q.pageSize,
      sales: sales.map((s) => ({
        ...s,
        grandTotal: s.grandTotal.toFixed(2),
        returns: s.returns.map((r) => ({ ...r, refundTotal: r.refundTotal.toFixed(2) })),
      })),
    });
  }),
);

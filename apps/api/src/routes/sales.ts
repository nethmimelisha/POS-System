import crypto from "node:crypto";
import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { asyncHandler, HttpError } from "../middleware/error.js";
import { requireRole } from "../middleware/auth.js";
import { sensitiveLimiter } from "../middleware/security.js";
import { audit } from "../services/audit.js";
import { getSettings, recordMovement } from "../services/stock.js";
import { priceSale, toCents } from "../services/pricing.js";
import { saleInclude, serializeSale } from "../services/saleView.js";
import { buildReceipt, formatMoney } from "../services/receipt.js";
import { lockOpenShift } from "../services/shifts.js";

export const salesRouter = Router();

const withinDp = (n: number, dp: number) => Math.abs(n * 10 ** dp - Math.round(n * 10 ** dp)) < 1e-6;
const amount = z
  .number()
  .positive()
  .max(99_999_999.99)
  .refine((n) => withinDp(n, 2), "At most 2 decimal places");
const quantity = z
  .number()
  .positive()
  .max(100_000)
  .refine((n) => withinDp(n, 3), "At most 3 decimal places");

const discountSchema = z
  .object({
    type: z.enum(["PERCENT", "AMOUNT"]),
    value: z
      .number()
      .min(0)
      .max(99_999_999.99)
      .refine((n) => withinDp(n, 2), "At most 2 decimal places"),
  })
  .strict();

// Strict objects: clients may not send prices, tax or totals. The server computes them.
export const saleInput = z
  .object({
    id: z.string().uuid(),
    registerId: z.number().int().positive(),
    customerId: z.string().uuid().nullable().optional(),
    items: z
      .array(
        z.object({ variantId: z.string().uuid(), quantity, discount: discountSchema.optional() }).strict(),
      )
      .min(1)
      .max(200),
    discount: discountSchema.optional(),
    payments: z
      .array(
        z
          .object({ method: z.string().min(1).max(30), amount, reference: z.string().trim().min(1).max(100).optional() })
          .strict(),
      )
      .min(1)
      .max(5),
    notes: z.string().max(500).optional(),
  })
  .strict();

const dollars = (cents: number) => (cents / 100).toFixed(2);

type Db = Prisma.TransactionClient | typeof prisma;
export type CartItem = z.infer<typeof saleInput>["items"][number];
export type Discount = z.infer<typeof discountSchema>;

/** Loads catalog data and prices a cart. Shared by checkout and the quote endpoint so both always agree. */
export async function priceCart(
  db: Db,
  items: CartItem[],
  discount: Discount | undefined,
  user: NonNullable<import("express").Request["user"]>,
  settings: Awaited<ReturnType<typeof getSettings>>,
) {
  const variantIds = [...new Set(items.map((i) => i.variantId))];
  const variants = await db.productVariant.findMany({
    where: { id: { in: variantIds } },
    include: { product: { include: { taxRate: true } } },
  });
  const byId = new Map(variants.map((v) => [v.id, v]));
  for (const id of variantIds) {
    const v = byId.get(id);
    if (!v) throw new HttpError(400, `Unknown item ${id}`);
    if (!v.isActive || !v.product.isActive) throw new HttpError(409, `Item ${v.sku} is not available for sale`);
  }

  const priced = priceSale(
    items.map((i) => {
      const v = byId.get(i.variantId)!;
      const rate = v.product.taxRate;
      return {
        unitPriceCents: toCents(Number(v.sellPrice)),
        quantity: i.quantity,
        discount: i.discount,
        taxRatePct: rate?.isActive && rate.type === "STANDARD" ? Number(rate.ratePct) : null,
      };
    }),
    discount,
    settings,
  );
  if (priced.grandTotalCents <= 0) throw new HttpError(400, "Sale total must be greater than zero");

  if (user.role === "CASHIER" && priced.discountCents * 100 > priced.subtotalCents * config.maxCashierDiscountPct) {
    throw new HttpError(403, `Discounts above ${config.maxCashierDiscountPct}% need manager approval`);
  }
  return { byId, priced };
}

const quoteInput = z.object({ items: saleInput.shape.items, discount: discountSchema.optional() }).strict();

// Prices a cart without saving anything, so the POS can show server-calculated totals before payment.
salesRouter.post(
  "/quote",
  asyncHandler(async (req, res) => {
    const input = quoteInput.parse(req.body);
    const settings = await getSettings();
    const { byId, priced } = await priceCart(prisma, input.items, input.discount, req.user!, settings);

    const requested = new Map<string, number>();
    input.items.forEach((i) => requested.set(i.variantId, (requested.get(i.variantId) ?? 0) + i.quantity));
    const levels = await prisma.stockLevel.findMany({ where: { variantId: { in: [...byId.keys()] } } });
    const onHandById = new Map(levels.map((l) => [l.variantId, Number(l.onHand)]));

    const lines = input.items.map((i, idx) => {
      const v = byId.get(i.variantId)!;
      const l = priced.lines[idx];
      const trackStock = v.product.trackStock;
      const onHand = onHandById.get(i.variantId) ?? 0;
      return {
        variantId: v.id,
        description: v.name ? `${v.product.name} - ${v.name}` : v.product.name,
        sku: v.sku,
        quantity: i.quantity,
        unitPrice: Number(v.sellPrice).toFixed(2),
        discount: dollars(l.discountCents),
        taxRatePct: l.taxRatePct,
        taxAmount: dollars(l.taxCents),
        lineTotal: dollars(l.totalCents),
        trackStock,
        onHand,
        insufficientStock: trackStock && !settings.allowNegativeStock && (requested.get(i.variantId) ?? 0) > onHand,
      };
    });
    res.json({
      lines,
      subtotal: dollars(priced.subtotalCents),
      discountTotal: dollars(priced.discountCents),
      taxTotal: dollars(priced.taxCents),
      grandTotal: dollars(priced.grandTotalCents),
      taxEnabled: settings.taxEnabled,
      pricesIncludeTax: settings.pricesIncludeTax,
      canCheckout: lines.every((l) => !l.insufficientStock),
    });
  }),
);
salesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = saleInput.parse(req.body);
    const user = req.user!;
    const requestHash = crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const settings = await getSettings();
    const money = (cents: number) => formatMoney(cents / 100, settings.currencySymbol);

    const { sale, replay } = await prisma.$transaction(
      async (tx) => {
        // Serialise requests carrying the same id so a retry can never create a second sale.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${input.id}))::text`;
        const existing = await tx.sale.findUnique({ where: { id: input.id }, include: saleInclude });
        if (existing) {
          if (existing.cashierId !== user.id || existing.requestHash !== requestHash) {
            throw new HttpError(409, "This sale id was already used with a different request");
          }
          return { sale: existing, replay: true };
        }

        const register = await tx.register.findUnique({ where: { id: input.registerId } });
        if (!register?.isActive) throw new HttpError(400, "Unknown or inactive register");
        if (input.customerId && !(await tx.customer.findUnique({ where: { id: input.customerId } }))) {
          throw new HttpError(400, "Unknown customer");
        }

        // Cash taken on this sale belongs to the open shift on the register (its drawer).
        const shiftId = await lockOpenShift(tx, register.id);
        if (settings.requireShift) {
          if (!shiftId) throw new HttpError(409, `Open a shift on ${register.name} before selling`);
          const shift = await tx.shift.findUniqueOrThrow({ where: { id: shiftId } });
          if (user.role === "CASHIER" && shift.cashierId !== user.id) {
            throw new HttpError(409, `${register.name} is in use by another cashier`);
          }
        }

        const { byId, priced } = await priceCart(tx, input.items, input.discount, user, settings);

        // Payments
        const codes = [...new Set(input.payments.map((p) => p.method))];
        const methods = await tx.paymentMethod.findMany({ where: { code: { in: codes } } });
        const methodByCode = new Map(methods.map((m) => [m.code, m]));
        let cashCents = 0;
        let nonCashCents = 0;
        for (const p of input.payments) {
          const method = methodByCode.get(p.method);
          if (!method?.isActive) throw new HttpError(400, `Unknown or inactive payment method: ${p.method}`);
          if (method.isCash) cashCents += toCents(p.amount);
          else {
            if (!p.reference) throw new HttpError(400, `A reference is required for ${method.name} payments`);
            nonCashCents += toCents(p.amount);
          }
        }
        const grand = priced.grandTotalCents;
        if (nonCashCents > grand) throw new HttpError(400, "Card and online payments cannot exceed the sale total");
        const tendered = cashCents + nonCashCents;
        if (tendered < grand) {
          throw new HttpError(402, `Insufficient payment: ${money(grand - tendered)} remaining`);
        }
        const changeCents = tendered - grand;

        // Deduct stock in a fixed order so concurrent sales cannot deadlock.
        const needed = new Map<string, number>();
        input.items.forEach((i) => {
          if (byId.get(i.variantId)!.product.trackStock) {
            needed.set(i.variantId, (needed.get(i.variantId) ?? 0) + i.quantity);
          }
        });
        for (const [variantId, qty] of [...needed].sort(([a], [b]) => a.localeCompare(b))) {
          const v = byId.get(variantId)!;
          try {
            await recordMovement(
              tx,
              {
                variantId,
                type: "SALE",
                quantity: -qty,
                unitCost: Number(v.costPrice),
                referenceType: "sale",
                referenceId: input.id,
                userId: user.id,
              },
              settings.allowNegativeStock,
            );
          } catch (e) {
            if (e instanceof HttpError && e.status === 409) {
              throw new HttpError(409, `Insufficient stock for ${v.sku}`);
            }
            throw e;
          }
        }

        // Taken last so the counter row is locked for as short a time as possible.
        const [{ value }] = await tx.$queryRaw<{ value: number }[]>`
          INSERT INTO "DocumentCounter" ("key", "value") VALUES ('sale', 1)
          ON CONFLICT ("key") DO UPDATE SET "value" = "DocumentCounter"."value" + 1
          RETURNING "value"`;
        const saleNumber = `INV-${String(value).padStart(6, "0")}`;

        const now = new Date();
        const created = await tx.sale.create({
          data: {
            id: input.id,
            saleNumber,
            status: "COMPLETED",
            registerId: register.id,
            cashierId: user.id,
            customerId: input.customerId ?? null,
            shiftId,
            subtotal: dollars(priced.subtotalCents),
            discountTotal: dollars(priced.discountCents),
            taxTotal: dollars(priced.taxCents),
            grandTotal: dollars(grand),
            amountPaid: dollars(tendered),
            changeGiven: dollars(changeCents),
            notes: input.notes,
            requestHash,
            completedAt: now,
            items: {
              create: input.items.map((i, idx) => {
                const v = byId.get(i.variantId)!;
                const l = priced.lines[idx];
                return {
                  variantId: v.id,
                  description: v.name ? `${v.product.name} - ${v.name}` : v.product.name,
                  sku: v.sku,
                  quantity: i.quantity,
                  unitPrice: v.sellPrice,
                  unitCost: v.costPrice,
                  discount: dollars(l.discountCents),
                  taxRatePct: l.taxRatePct,
                  taxAmount: dollars(l.taxCents),
                  lineTotal: dollars(l.totalCents),
                };
              }),
            },
            payments: {
              create: input.payments.map((p) => ({
                methodId: methodByCode.get(p.method)!.id,
                amount: p.amount.toFixed(2),
                reference: p.reference,
              })),
            },
          },
          include: saleInclude,
        });
        return { sale: created, replay: false };
      },
      { maxWait: 10_000, timeout: 20_000 },
    );

    if (!replay) {
      await audit(req, "sale.create", "Sale", sale.id, {
        saleNumber: sale.saleNumber,
        registerId: sale.registerId,
        grandTotal: sale.grandTotal.toString(),
        discountTotal: sale.discountTotal.toString(),
        items: sale.items.length,
      });
    }
    res.setHeader("Idempotent-Replay", String(replay));
    res.status(replay ? 200 : 201).json(serializeSale(sale));
  }),
);

salesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        status: z.enum(["HELD", "COMPLETED", "VOIDED"]).optional(),
        cashierId: z.string().uuid().optional(),
        customerId: z.string().uuid().optional(),
        search: z.string().trim().min(1).max(40).optional(),
        registerId: z.coerce.number().int().optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
      })
      .parse(req.query);

    const where: Prisma.SaleWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.registerId ? { registerId: q.registerId } : {}),
      ...(q.customerId ? { customerId: q.customerId } : {}),
      ...(q.search ? { saleNumber: { contains: q.search, mode: "insensitive" as const } } : {}),
      ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
      // Cashiers only ever see their own sales.
      ...(req.user!.role === "CASHIER" ? { cashierId: req.user!.id } : q.cashierId ? { cashierId: q.cashierId } : {}),
    };
    const [total, items] = await prisma.$transaction([
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
          discountTotal: true,
          taxTotal: true,
          createdAt: true,
          registerId: true,
          cashier: { select: { id: true, fullName: true } },
          _count: { select: { items: true } },
        },
      }),
    ]);
    res.json({ total, page: q.page, pageSize: q.pageSize, items });
  }),
);

async function loadSale(req: import("express").Request) {
  const id = z.string().uuid().safeParse(req.params.id);
  const sale = id.success ? await prisma.sale.findUnique({ where: { id: id.data }, include: saleInclude }) : null;
  if (!sale || (req.user!.role === "CASHIER" && sale.cashierId !== req.user!.id)) {
    throw new HttpError(404, "Sale not found");
  }
  return sale;
}

salesRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const sale = await loadSale(req);
    const returns = await prisma.saleReturn.findMany({
      where: { saleId: sale.id },
      orderBy: { createdAt: "asc" },
      select: { id: true, returnNumber: true, refundTotal: true, createdAt: true },
    });
    res.json({ ...serializeSale(sale), returns });
  }),
);

salesRouter.get(
  "/:id/receipt",
  asyncHandler(async (req, res) => {
    const [sale, settings] = await Promise.all([loadSale(req), getSettings()]);
    res.json(buildReceipt(sale, settings));
  }),
);

// ---------- Held (pending) sales and voids ----------
//
// Two separate workflows, on purpose:
//  * HELD  = a parked cart. Nothing was paid and no stock was taken, so voiding it only closes the record.
//  * COMPLETED = money and stock moved. It is never voided or deleted; the Returns workflow refunds it and keeps every record.

const holdInput = z
  .object({
    id: saleInput.shape.id,
    registerId: saleInput.shape.registerId,
    customerId: saleInput.shape.customerId,
    items: saleInput.shape.items,
    discount: discountSchema.optional(),
    notes: z.string().max(500).optional(),
  })
  .strict();

salesRouter.post(
  "/hold",
  asyncHandler(async (req, res) => {
    const input = holdInput.parse(req.body);
    const user = req.user!;
    const requestHash = crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const settings = await getSettings();

    const { sale, replay } = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${input.id}))::text`;
      const existing = await tx.sale.findUnique({ where: { id: input.id }, include: saleInclude });
      if (existing) {
        if (existing.cashierId !== user.id || existing.requestHash !== requestHash) {
          throw new HttpError(409, "This sale id was already used with a different request");
        }
        return { sale: existing, replay: true };
      }
      const register = await tx.register.findUnique({ where: { id: input.registerId } });
      if (!register?.isActive) throw new HttpError(400, "Unknown or inactive register");
      if (input.customerId && !(await tx.customer.findUnique({ where: { id: input.customerId } }))) {
        throw new HttpError(400, "Unknown customer");
      }
      const { byId, priced } = await priceCart(tx, input.items, input.discount, user, settings);
      const [{ value }] = await tx.$queryRaw<{ value: number }[]>`
        INSERT INTO "DocumentCounter" ("key", "value") VALUES ('hold', 1)
        ON CONFLICT ("key") DO UPDATE SET "value" = "DocumentCounter"."value" + 1
        RETURNING "value"`;
      const created = await tx.sale.create({
        data: {
          id: input.id,
          saleNumber: `HLD-${String(value).padStart(6, "0")}`,
          status: "HELD",
          registerId: register.id,
          cashierId: user.id,
          customerId: input.customerId ?? null,
          subtotal: dollars(priced.subtotalCents),
          discountTotal: dollars(priced.discountCents),
          taxTotal: dollars(priced.taxCents),
          grandTotal: dollars(priced.grandTotalCents),
          notes: input.notes,
          requestHash,
          items: {
            create: input.items.map((i, idx) => {
              const v = byId.get(i.variantId)!;
              const l = priced.lines[idx];
              return {
                variantId: v.id,
                description: v.name ? `${v.product.name} - ${v.name}` : v.product.name,
                sku: v.sku,
                quantity: i.quantity,
                unitPrice: v.sellPrice,
                unitCost: v.costPrice,
                discount: dollars(l.discountCents),
                taxRatePct: l.taxRatePct,
                taxAmount: dollars(l.taxCents),
                lineTotal: dollars(l.totalCents),
              };
            }),
          },
        },
        include: saleInclude,
      });
      return { sale: created, replay: false };
    });
    if (!replay) await audit(req, "sale.hold", "Sale", sale.id, { saleNumber: sale.saleNumber, grandTotal: sale.grandTotal.toString() });
    res.setHeader("Idempotent-Replay", String(replay));
    res.status(replay ? 200 : 201).json(serializeSale(sale));
  }),
);

const voidInput = z.object({ reason: z.string().trim().min(3, "A reason is required").max(300) }).strict();

salesRouter.post(
  "/:id/void",
  sensitiveLimiter,
  requireRole("ADMIN", "MANAGER"),
  asyncHandler(async (req, res) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) throw new HttpError(404, "Sale not found");
    const { reason } = voidInput.parse(req.body);
    const user = req.user!;

    const outcome = await prisma.$transaction(async (tx) => {
      // The row lock makes a second, simultaneous void wait and then see VOIDED.
      const rows = await tx.$queryRaw<{ status: string }[]>`SELECT status::text FROM "Sale" WHERE id = ${id.data} FOR UPDATE`;
      if (!rows.length) throw new HttpError(404, "Sale not found");
      const sale = await tx.sale.findUniqueOrThrow({ where: { id: id.data }, include: saleInclude });
      if (sale.status === "VOIDED") return { kind: "already" as const, sale };
      if (sale.status === "COMPLETED") return { kind: "completed" as const, sale };

      // A held sale has no payments and no stock movements. If that ever stops being true, refuse rather than leave money or stock unaccounted for.
      const moved = await tx.stockMovement.count({ where: { referenceType: "sale", referenceId: sale.id } });
      if (sale.payments.length || moved) throw new HttpError(409, "This sale has payments or stock movements and cannot be voided");

      const voided = await tx.sale.update({
        where: { id: sale.id },
        data: { status: "VOIDED", voidedAt: new Date(), voidedById: user.id, voidReason: reason },
        include: saleInclude,
      });
      return { kind: "voided" as const, sale: voided };
    });

    if (outcome.kind === "completed") {
      await audit(req, "sale.void_rejected", "Sale", outcome.sale.id, { saleNumber: outcome.sale.saleNumber, reason });
      return res.status(409).json({
        error: "Completed sales cannot be voided. Refund them from Returns, which keeps the sale, stock and payment records intact.",
        code: "USE_RETURNS",
      });
    }
    if (outcome.kind === "already") {
      return res.status(409).json({ error: `Sale ${outcome.sale.saleNumber} is already voided`, code: "ALREADY_VOIDED" });
    }
    await audit(req, "sale.void", "Sale", outcome.sale.id, {
      saleNumber: outcome.sale.saleNumber,
      reason,
      items: outcome.sale.items.length,
      grandTotal: outcome.sale.grandTotal.toString(),
      workflow: "held",
    });
    res.json(serializeSale(outcome.sale));
  }),
);
import crypto from "node:crypto";
import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db.js";
import { asyncHandler, HttpError } from "../middleware/error.js";
import { requireRole } from "../middleware/auth.js";
import { audit } from "../services/audit.js";
import { getSettings, recordMovement } from "../services/stock.js";
import { lockOpenShift } from "../services/shifts.js";
import { buildReturnReceipt, formatMoney } from "../services/receipt.js";

// Refunds move money, so every returns endpoint is limited to managers and admins.
export const returnsRouter = Router();
returnsRouter.use(requireRole("ADMIN", "MANAGER"));

export const D = (v: Prisma.Decimal.Value | null | undefined) => new Prisma.Decimal(v ?? 0);
const ROUND = Prisma.Decimal.ROUND_HALF_UP;
const withinDp = (n: number, dp: number) => Math.abs(n * 10 ** dp - Math.round(n * 10 ** dp)) < 1e-6;

export const lineSchema = z
  .object({
    saleItemId: z.string().regex(/^\d{1,18}$/, "Invalid sale item"),
    quantity: z.number().positive().max(100_000).refine((n) => withinDp(n, 3), "At most 3 decimal places"),
    resellable: z.boolean(), // explicit: stock is restored only for lines the manager marks resellable
  })
  .strict();

export const refundSchema = z
  .object({
    method: z.string().min(1).max(30),
    amount: z.number().positive().max(99_999_999.99).refine((n) => withinDp(n, 2), "At most 2 decimal places"),
    reference: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

const items = z
  .array(lineSchema)
  .min(1)
  .max(200)
  .refine((l) => new Set(l.map((i) => i.saleItemId)).size === l.length, "Each sale item may appear only once");

const returnInput = z
  .object({
    id: z.string().uuid(),
    saleId: z.string().uuid(),
    registerId: z.number().int().positive(),
    reason: z.enum(["DEFECTIVE", "DAMAGED", "WRONG_ITEM", "CHANGED_MIND", "OVERCHARGED", "OTHER"]),
    notes: z.string().trim().max(500).optional(),
    items,
    refunds: z.array(refundSchema).max(5).default([]),
  })
  .strict();

type Tx = Prisma.TransactionClient | typeof prisma;

interface ComputedLine {
  saleItemId: bigint;
  variantId: string;
  description: string;
  sku: string;
  unitCost: Prisma.Decimal;
  quantity: Prisma.Decimal;
  refundAmount: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  discountAmount: Prisma.Decimal;
}

const share = (total: Prisma.Decimal, q: Prisma.Decimal, sold: Prisma.Decimal, alreadyTaken: Prisma.Decimal, last: boolean) => {
  const left = total.minus(alreadyTaken);
  if (last) return left;
  const part = total.times(q).div(sold).toDecimalPlaces(2, ROUND);
  return Prisma.Decimal.min(part, left);
};

/**
 * Works out what a return is worth from the original sale snapshot. Callers that create a return
 * must hold the sale row lock so the "already returned" figures cannot change underneath them.
 */
export async function computeReturn(tx: Tx, saleId: string, lines: { saleItemId: string; quantity: number }[]) {
  const sale = await tx.sale.findUnique({ where: { id: saleId }, include: { items: true } });
  if (!sale) throw new HttpError(404, "Sale not found");
  if (sale.status !== "COMPLETED") throw new HttpError(409, "Only completed sales can be returned");

  const byId = new Map(sale.items.map((i) => [i.id.toString(), i]));
  const prior = await tx.returnItem.groupBy({
    by: ["saleItemId"],
    where: { saleItemId: { in: sale.items.map((i) => i.id) } },
    _sum: { quantity: true, refundAmount: true, taxAmount: true, discountAmount: true },
  });
  const priorById = new Map(prior.map((p) => [p.saleItemId.toString(), p._sum]));

  const computed: ComputedLine[] = lines.map((l) => {
    const item = byId.get(l.saleItemId);
    if (!item) throw new HttpError(400, "A returned item does not belong to this sale");
    const done = priorById.get(l.saleItemId);
    const sold = D(item.quantity);
    const remaining = sold.minus(D(done?.quantity));
    const q = D(l.quantity);
    if (q.greaterThan(remaining)) {
      throw new HttpError(
        409,
        remaining.isZero()
          ? `${item.description} has already been fully returned`
          : `Cannot return ${q.toString()} of ${item.description}: only ${remaining.toString()} remaining`,
      );
    }
    const last = q.equals(remaining);
    return {
      saleItemId: item.id,
      variantId: item.variantId,
      description: item.description,
      sku: item.sku,
      unitCost: D(item.unitCost),
      quantity: q,
      refundAmount: share(D(item.lineTotal), q, sold, D(done?.refundAmount), last),
      taxAmount: share(D(item.taxAmount), q, sold, D(done?.taxAmount), last),
      discountAmount: share(D(item.discount), q, sold, D(done?.discountAmount), last),
    };
  });
  const total = computed.reduce((a, l) => a.plus(l.refundAmount), D(0));
  const tax = computed.reduce((a, l) => a.plus(l.taxAmount), D(0));
  return { sale, computed, total, tax };
}

export const returnInclude = {
  items: { orderBy: { id: "asc" } },
  refunds: { include: { method: true }, orderBy: { id: "asc" } },
  sale: { select: { id: true, saleNumber: true, grandTotal: true, createdAt: true } },
  processedBy: { select: { id: true, fullName: true } },
  register: true,
  customer: true,
} satisfies Prisma.SaleReturnInclude;

export type ReturnFull = Prisma.SaleReturnGetPayload<{ include: typeof returnInclude }>;

// Money is returned as 2dp strings and quantities as plain strings; BigInt ids cannot be JSON-serialised.
export const serialize = (r: ReturnFull) => {
  const { requestHash: _h, ...rest } = r;
  return {
    ...rest,
    subtotal: D(r.subtotal).toFixed(2),
    taxTotal: D(r.taxTotal).toFixed(2),
    refundTotal: D(r.refundTotal).toFixed(2),
    sale: { ...r.sale, grandTotal: D(r.sale.grandTotal).toFixed(2) },
    items: r.items.map((i) => ({
      ...i,
      id: i.id.toString(),
      saleItemId: i.saleItemId.toString(),
      quantity: D(i.quantity).toString(),
      taxAmount: D(i.taxAmount).toFixed(2),
      refundAmount: D(i.refundAmount).toFixed(2),
      discountAmount: D(i.discountAmount).toFixed(2),
    })),
    refunds: r.refunds.map((f) => ({ ...f, amount: D(f.amount).toFixed(2) })),
  };
};

const loadReturn = async (id: string) => {
  const ok = z.string().uuid().safeParse(id);
  const ret = ok.success ? await prisma.saleReturn.findUnique({ where: { id: ok.data }, include: returnInclude }) : null;
  if (!ret) throw new HttpError(404, "Return not found");
  return ret;
};

// What can still be returned from a sale.
returnsRouter.get(
  "/sale/:saleId/returnable",
  asyncHandler(async (req, res) => {
    const saleId = z.string().uuid().safeParse(req.params.saleId);
    if (!saleId.success) throw new HttpError(404, "Sale not found");
    const sale = await prisma.sale.findUnique({
      where: { id: saleId.data },
      include: { items: { orderBy: { id: "asc" } }, payments: { include: { method: true } }, customer: true, cashier: { select: { fullName: true } } },
    });
    if (!sale) throw new HttpError(404, "Sale not found");
    const prior = await prisma.returnItem.groupBy({
      by: ["saleItemId"],
      where: { saleItemId: { in: sale.items.map((i) => i.id) } },
      _sum: { quantity: true, refundAmount: true },
    });
    const priorById = new Map(prior.map((p) => [p.saleItemId.toString(), p._sum]));
    const rows = sale.items.map((i) => {
      const done = priorById.get(i.id.toString());
      const returned = D(done?.quantity);
      return {
        saleItemId: i.id.toString(),
        description: i.description,
        sku: i.sku,
        soldQuantity: D(i.quantity).toString(),
        returnedQuantity: returned.toString(),
        remainingQuantity: D(i.quantity).minus(returned).toString(),
        unitPrice: D(i.unitPrice).toFixed(2),
        lineTotal: D(i.lineTotal).toFixed(2),
        refundedAmount: D(done?.refundAmount).toFixed(2),
        remainingRefundable: D(i.lineTotal).minus(D(done?.refundAmount)).toFixed(2),
      };
    });
    const refunded = await prisma.$queryRaw<{ code: string; amount: string }[]>`
      SELECT m.code, COALESCE(SUM(rr.amount), 0)::text AS amount
      FROM "ReturnRefund" rr JOIN "SaleReturn" r ON r.id = rr."returnId" JOIN "PaymentMethod" m ON m.id = rr."methodId"
      WHERE r."saleId" = ${sale.id} AND rr.status <> 'FAILED' GROUP BY m.code`;
    res.json({
      sale: {
        id: sale.id,
        saleNumber: sale.saleNumber,
        status: sale.status,
        grandTotal: D(sale.grandTotal).toFixed(2),
        createdAt: sale.createdAt,
        cashier: sale.cashier.fullName,
        customer: sale.customer ? { id: sale.customer.id, name: sale.customer.name } : null,
      },
      items: rows,
      fullyReturned: rows.every((r) => D(r.remainingQuantity).isZero()),
      paidByMethod: sale.payments.map((p) => ({ method: p.method.code, name: p.method.name, amount: D(p.amount).toFixed(2) })),
      refundedByMethod: refunded.map((r) => ({ method: r.code, amount: D(r.amount).toFixed(2) })),
    });
  }),
);

// Prices a return without saving it, so the screen can show the exact refund before confirming.
returnsRouter.post(
  "/quote",
  asyncHandler(async (req, res) => {
    const input = z
      .object({ saleId: z.string().uuid(), items: z.array(lineSchema.omit({ resellable: true })).min(1).max(200) })
      .parse(req.body);
    const { total, tax, computed } = await computeReturn(prisma, input.saleId, input.items);
    res.json({
      refundTotal: total.toFixed(2),
      taxTotal: tax.toFixed(2),
      lines: computed.map((l) => ({ saleItemId: l.saleItemId.toString(), quantity: l.quantity.toString(), refundAmount: l.refundAmount.toFixed(2) })),
    });
  }),
);

returnsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = returnInput.parse(req.body);
    const user = req.user!;
    const requestHash = crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const settings = await getSettings();

    const { ret, replay } = await prisma.$transaction(
      async (tx) => {
        // Same return id: serialise, then replay the stored result.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${input.id}))::text`;
        const existing = await tx.saleReturn.findUnique({ where: { id: input.id }, include: returnInclude });
        if (existing) {
          if (existing.processedById !== user.id || existing.requestHash !== requestHash) {
            throw new HttpError(409, "This return id was already used with a different request");
          }
          return { ret: existing, replay: true };
        }

        // Different return ids against the same sale queue up here, so the same item can never be refunded twice.
        const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Sale" WHERE id = ${input.saleId} FOR UPDATE`;
        if (!locked.length) throw new HttpError(404, "Sale not found");

        const register = await tx.register.findUnique({ where: { id: input.registerId } });
        if (!register?.isActive) throw new HttpError(400, "Unknown or inactive register");

        const { sale, computed, total, tax } = await computeReturn(tx, input.saleId, input.items);
        const resellable = new Map(input.items.map((i) => [i.saleItemId, i.resellable]));

        // Refund methods
        const codes = [...new Set(input.refunds.map((r) => r.method))];
        const methods = await tx.paymentMethod.findMany({ where: { code: { in: codes } } });
        const methodByCode = new Map(methods.map((m) => [m.code, m]));
        const refundSum = input.refunds.reduce((a, r) => a.plus(r.amount.toFixed(2)), D(0));
        if (!refundSum.equals(total)) {
          throw new HttpError(400, `Refund amounts must add up to ${formatMoney(total.toFixed(2), settings.currencySymbol)} (got ${formatMoney(refundSum.toFixed(2), settings.currencySymbol)})`);
        }
        for (const r of input.refunds) {
          if (!methodByCode.get(r.method)?.isActive) throw new HttpError(400, `Unknown or inactive payment method: ${r.method}`);
        }

        // Card/online refunds may only go back to what was paid that way (net of earlier refunds).
        const paid = await tx.salePayment.groupBy({ by: ["methodId"], where: { saleId: sale.id }, _sum: { amount: true } });
        const refundedBefore = await tx.$queryRaw<{ methodId: number; amount: string }[]>`
          SELECT rr."methodId", COALESCE(SUM(rr.amount), 0)::text AS amount
          FROM "ReturnRefund" rr JOIN "SaleReturn" r ON r.id = rr."returnId"
          WHERE r."saleId" = ${sale.id} AND rr.status <> 'FAILED' GROUP BY rr."methodId"`;
        for (const code of codes) {
          const method = methodByCode.get(code)!;
          if (method.isCash) continue;
          const want = input.refunds.filter((r) => r.method === code).reduce((a, r) => a.plus(r.amount.toFixed(2)), D(0));
          const room = D(paid.find((p) => p.methodId === method.id)?._sum.amount).minus(D(refundedBefore.find((p) => p.methodId === method.id)?.amount));
          if (want.greaterThan(room)) {
            throw new HttpError(409, `${method.name} refunds cannot exceed ${formatMoney(room.toFixed(2), settings.currencySymbol)} (the amount originally paid that way and not yet refunded)`);
          }
        }

        // Drawer link: cash refunds come out of the register's open shift.
        const hasCash = input.refunds.some((r) => methodByCode.get(r.method)!.isCash);
        const shiftId = await lockOpenShift(tx, register.id);
        if (settings.requireShift && hasCash && !shiftId) {
          throw new HttpError(409, `Open a shift on ${register.name} before paying a cash refund`);
        }

        // Restock resellable lines in a fixed order so concurrent work cannot deadlock.
        const variants = await tx.productVariant.findMany({
          where: { id: { in: computed.map((c) => c.variantId) } },
          include: { product: { select: { trackStock: true } } },
        });
        const trackById = new Map(variants.map((v) => [v.id, v.product.trackStock]));
        const restock = new Map<string, { qty: Prisma.Decimal; cost: Prisma.Decimal }>();
        for (const c of computed) {
          if (!resellable.get(c.saleItemId.toString()) || !trackById.get(c.variantId)) continue;
          const cur = restock.get(c.variantId);
          restock.set(c.variantId, { qty: (cur?.qty ?? D(0)).plus(c.quantity), cost: c.unitCost });
        }

        const [{ value }] = await tx.$queryRaw<{ value: number }[]>`
          INSERT INTO "DocumentCounter" ("key", "value") VALUES ('return', 1)
          ON CONFLICT ("key") DO UPDATE SET "value" = "DocumentCounter"."value" + 1
          RETURNING "value"`;
        const returnNumber = `RET-${String(value).padStart(6, "0")}`;

        for (const [variantId, r] of [...restock].sort(([a], [b]) => a.localeCompare(b))) {
          await recordMovement(
            tx,
            {
              variantId,
              type: "RETURN_IN",
              quantity: r.qty.toNumber(),
              unitCost: r.cost.toNumber(),
              referenceType: "return",
              referenceId: input.id,
              reason: `${returnNumber} (${input.reason})`,
              userId: user.id,
            },
            true,
          );
        }

        const created = await tx.saleReturn.create({
          data: {
            id: input.id,
            returnNumber,
            saleId: sale.id,
            registerId: register.id,
            shiftId,
            processedById: user.id,
            customerId: sale.customerId,
            reason: input.reason,
            notes: input.notes,
            subtotal: total.minus(tax).toFixed(2),
            taxTotal: tax.toFixed(2),
            refundTotal: total.toFixed(2),
            requestHash,
            items: {
              create: computed.map((c) => {
                const canRestock = !!resellable.get(c.saleItemId.toString()) && !!trackById.get(c.variantId);
                return {
                  saleItemId: c.saleItemId,
                  variantId: c.variantId,
                  description: c.description,
                  sku: c.sku,
                  quantity: c.quantity.toString(),
                  taxAmount: c.taxAmount.toFixed(2),
                  refundAmount: c.refundAmount.toFixed(2),
                  discountAmount: c.discountAmount.toFixed(2),
                  resellable: !!resellable.get(c.saleItemId.toString()),
                  restocked: canRestock,
                };
              }),
            },
            refunds: {
              create: input.refunds.map((r) => {
                const method = methodByCode.get(r.method)!;
                return {
                  methodId: method.id,
                  amount: r.amount.toFixed(2),
                  reference: r.reference,
                  // Cash leaves the drawer immediately. External refunds stay PENDING until the provider confirms.
                  status: method.isCash ? ("COMPLETED" as const) : ("PENDING" as const),
                  resolvedById: method.isCash ? user.id : null,
                  resolvedAt: method.isCash ? new Date() : null,
                };
              }),
            },
          },
          include: returnInclude,
        });
        return { ret: created, replay: false };
      },
      { maxWait: 10_000, timeout: 20_000 },
    );

    if (!replay) {
      await audit(req, "return.create", "SaleReturn", ret.id, {
        returnNumber: ret.returnNumber,
        saleId: ret.saleId,
        reason: ret.reason,
        refundTotal: ret.refundTotal.toString(),
        restocked: ret.items.filter((i) => i.restocked).length,
        pendingRefunds: ret.refunds.filter((r) => r.status === "PENDING").length,
      });
    }
    res.setHeader("Idempotent-Replay", String(replay));
    res.status(replay ? 200 : 201).json(serialize(ret));
  }),
);

returnsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        saleId: z.string().uuid().optional(),
        customerId: z.string().uuid().optional(),
        search: z.string().trim().min(1).max(40).optional(),
        pendingRefunds: z.enum(["true", "false"]).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
      })
      .parse(req.query);
    const where: Prisma.SaleReturnWhereInput = {
      ...(q.saleId ? { saleId: q.saleId } : {}),
      ...(q.customerId ? { customerId: q.customerId } : {}),
      ...(q.pendingRefunds === "true" ? { refunds: { some: { status: "PENDING" } } } : {}),
      ...(q.search
        ? {
            OR: [
              { returnNumber: { contains: q.search, mode: "insensitive" } },
              { sale: { saleNumber: { contains: q.search, mode: "insensitive" } } },
            ],
          }
        : {}),
      ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
    };
    const [total, rows] = await prisma.$transaction([
      prisma.saleReturn.count({ where }),
      prisma.saleReturn.findMany({
        where,
        include: returnInclude,
        orderBy: { createdAt: "desc" },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    res.json({ total, page: q.page, pageSize: q.pageSize, items: rows.map(serialize) });
  }),
);

returnsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json(serialize(await loadReturn(String(req.params.id))));
  }),
);

returnsRouter.get(
  "/:id/receipt",
  asyncHandler(async (req, res) => {
    const [ret, settings] = await Promise.all([loadReturn(String(req.params.id)), getSettings()]);
    res.json(buildReturnReceipt(ret, settings));
  }),
);

// External refunds are only completed after the payment provider confirms them.
async function resolveRefund(req: import("express").Request, to: "COMPLETED" | "FAILED") {
  const returnId = String(req.params.id);
  const refundId = z.coerce.number().int().positive().safeParse(req.params.refundId);
  if (!refundId.success) throw new HttpError(404, "Refund not found");
  const body = z
    .object({
      providerReference: z.string().trim().min(1).max(100).optional(),
      reason: z.string().trim().min(3).max(300).optional(),
    })
    .strict()
    .parse(req.body ?? {});
  if (to === "COMPLETED" && !body.providerReference) throw new HttpError(400, "The payment provider's confirmation reference is required");
  if (to === "FAILED" && !body.reason) throw new HttpError(400, "A reason is required");

  const refund = await prisma.returnRefund.findFirst({ where: { id: refundId.data, returnId }, include: { method: true } });
  if (!refund) throw new HttpError(404, "Refund not found");
  if (refund.method.isCash) throw new HttpError(409, "Cash refunds are completed when paid");
  const done = await prisma.returnRefund.updateMany({
    where: { id: refund.id, status: "PENDING" },
    data: {
      status: to,
      resolvedById: req.user!.id,
      resolvedAt: new Date(),
      providerReference: body.providerReference,
      failureReason: body.reason,
    },
  });
  if (done.count === 0) throw new HttpError(409, `This refund is already ${refund.status.toLowerCase()}`);
  await audit(req, to === "COMPLETED" ? "refund.confirm" : "refund.fail", "SaleReturn", returnId, {
    refundId: refund.id,
    method: refund.method.code,
    amount: refund.amount.toString(),
    ...body,
  });
  return serialize(await loadReturn(returnId));
}

returnsRouter.post("/:id/refunds/:refundId/confirm", asyncHandler(async (req, res) => res.json(await resolveRefund(req, "COMPLETED"))));
returnsRouter.post("/:id/refunds/:refundId/fail", asyncHandler(async (req, res) => res.json(await resolveRefund(req, "FAILED"))));

// Re-issues the unpaid part of a return after a card/online refund failed. Non-cash only, so a closed
// shift's drawer is never changed after the fact.
returnsRouter.post(
  "/:id/refunds",
  asyncHandler(async (req, res) => {
    const returnId = String(req.params.id);
    const input = refundSchema.parse(req.body);
    await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "SaleReturn" WHERE id = ${returnId} FOR UPDATE`;
      if (!rows.length) throw new HttpError(404, "Return not found");
      const method = await tx.paymentMethod.findUnique({ where: { code: input.method } });
      if (!method?.isActive) throw new HttpError(400, `Unknown or inactive payment method: ${input.method}`);
      if (method.isCash) throw new HttpError(400, "Replacement refunds must be card or online");
      const ret = await tx.saleReturn.findUniqueOrThrow({ where: { id: returnId }, include: { refunds: true } });
      const issued = ret.refunds.filter((r) => r.status !== "FAILED").reduce((a, r) => a.plus(r.amount), D(0));
      const owed = D(ret.refundTotal).minus(issued);
      if (D(input.amount.toFixed(2)).greaterThan(owed)) {
        throw new HttpError(409, `Only ${owed.toFixed(2)} of this return is still unpaid`);
      }
      await tx.returnRefund.create({
        data: { returnId, methodId: method.id, amount: input.amount.toFixed(2), reference: input.reference, status: "PENDING" },
      });
    });
    await audit(req, "refund.reissue", "SaleReturn", returnId, { method: input.method, amount: input.amount });
    res.status(201).json(serialize(await loadReturn(returnId)));
  }),
);
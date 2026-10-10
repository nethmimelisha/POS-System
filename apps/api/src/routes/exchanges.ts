import crypto from "node:crypto";
import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db.js";
import { asyncHandler, HttpError } from "../middleware/error.js";
import { requireRole } from "../middleware/auth.js";
import { audit } from "../services/audit.js";
import { getSettings, recordMovement } from "../services/stock.js";
import { toCents } from "../services/pricing.js";
import { lockOpenShift } from "../services/shifts.js";
import { saleInclude, serializeSale } from "../services/saleView.js";
import { buildReceipt, buildReturnReceipt, formatMoney } from "../services/receipt.js";
import { computeReturn, D, lineSchema, refundSchema, returnInclude, serialize as serializeReturn } from "./returns.js";
import { priceCart, saleInput } from "./sales.js";

/**
 * An exchange is one atomic operation made of two ordinary documents:
 *   1. a return of items from the original invoice (refund value R), and
 *   2. a new sale for the replacement items (value N).
 * R is applied to the new sale as "exchange credit" (an internal, non-cash method). Only the difference moves money:
 *   N > R  the customer pays N - R (cash / card / online, with change for cash)
 *   N < R  the customer is refunded R - N (same rules as a normal refund; card and online refunds stay PENDING)
 *   N = R  nothing changes hands
 * Because both documents are real records, stock, reports and the cash drawer need no special handling.
 */
export const exchangesRouter = Router();
exchangesRouter.use(requireRole("ADMIN", "MANAGER"));

const withinDp = (n: number, dp: number) => Math.abs(n * 10 ** dp - Math.round(n * 10 ** dp)) < 1e-6;
const payment = z
  .object({
    method: z.string().min(1).max(30),
    amount: z.number().positive().max(99_999_999.99).refine((n) => withinDp(n, 2), "At most 2 decimal places"),
    reference: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

const returnItems = z
  .array(lineSchema)
  .min(1)
  .max(200)
  .refine((l) => new Set(l.map((i) => i.saleItemId)).size === l.length, "Each sale item may appear only once");

const exchangeInput = z
  .object({
    id: z.string().uuid(),
    saleId: z.string().uuid(),
    registerId: z.number().int().positive(),
    reason: z.enum(["DEFECTIVE", "DAMAGED", "WRONG_ITEM", "CHANGED_MIND", "OVERCHARGED", "OTHER"]),
    notes: z.string().trim().max(500).optional(),
    returnItems,
    newItems: saleInput.shape.items,
    discount: saleInput.shape.discount,
    payments: z.array(payment).max(5).default([]),
    refunds: z.array(refundSchema).max(5).default([]),
  })
  .strict();

const dollars = (cents: number) => (cents / 100).toFixed(2);
const centsOf = (d: Prisma.Decimal) => d.times(100).toDecimalPlaces(0).toNumber();

const exchangeInclude = {
  return: { include: returnInclude },
  newSale: { include: saleInclude },
  originalSale: { select: { id: true, saleNumber: true } },
  processedBy: { select: { id: true, fullName: true } },
} satisfies Prisma.ExchangeInclude;
type ExchangeFull = Prisma.ExchangeGetPayload<{ include: typeof exchangeInclude }>;

const direction = (diff: Prisma.Decimal) => (diff.isZero() ? "EVEN" : diff.isPositive() ? "CUSTOMER_PAYS" : "REFUND_DUE");

function serializeExchange(x: ExchangeFull) {
  const { requestHash: _h, ...rest } = x;
  return {
    ...rest,
    returnedValue: D(x.returnedValue).toFixed(2),
    issuedValue: D(x.issuedValue).toFixed(2),
    difference: D(x.difference).toFixed(2),
    direction: direction(D(x.difference)),
    return: serializeReturn(x.return),
    newSale: serializeSale(x.newSale),
  };
}

const loadExchange = async (idRaw: string) => {
  const id = z.string().uuid().safeParse(idRaw);
  const x = id.success ? await prisma.exchange.findUnique({ where: { id: id.data }, include: exchangeInclude }) : null;
  if (!x) throw new HttpError(404, "Exchange not found");
  return x;
};

// Prices an exchange without saving anything so the screen can show the difference before confirming.
exchangesRouter.post(
  "/quote",
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        saleId: z.string().uuid(),
        returnItems: z.array(lineSchema.omit({ resellable: true })).min(1).max(200),
        newItems: saleInput.shape.items,
        discount: saleInput.shape.discount,
      })
      .strict()
      .parse(req.body);
    const settings = await getSettings();
    const { total } = await computeReturn(prisma, input.saleId, input.returnItems);
    const { byId, priced } = await priceCart(prisma, input.newItems, input.discount, req.user!, settings);

    const requested = new Map<string, number>();
    input.newItems.forEach((i) => requested.set(i.variantId, (requested.get(i.variantId) ?? 0) + i.quantity));
    const levels = await prisma.stockLevel.findMany({ where: { variantId: { in: [...byId.keys()] } } });
    const onHand = new Map(levels.map((l) => [l.variantId, Number(l.onHand)]));
    const returnedByVariant = new Map<string, number>();
    const items = await prisma.saleItem.findMany({ where: { id: { in: input.returnItems.map((i) => BigInt(i.saleItemId)) } } });
    for (const r of input.returnItems) {
      const it = items.find((x) => x.id.toString() === r.saleItemId);
      if (it) returnedByVariant.set(it.variantId, (returnedByVariant.get(it.variantId) ?? 0) + r.quantity);
    }

    const diffCents = priced.grandTotalCents - centsOf(total);
    res.json({
      returnedValue: total.toFixed(2),
      issuedValue: dollars(priced.grandTotalCents),
      difference: dollars(diffCents),
      direction: direction(D(diffCents)),
      lines: input.newItems.map((i, idx) => {
        const v = byId.get(i.variantId)!;
        const l = priced.lines[idx];
        // Resellable returns restock first, but the screen cannot know which are resellable yet, so it reports the cautious figure.
        const insufficientStock = v.product.trackStock && !settings.allowNegativeStock && (requested.get(i.variantId) ?? 0) > (onHand.get(i.variantId) ?? 0);
        return {
          variantId: v.id,
          description: v.name ? `${v.product.name} - ${v.name}` : v.product.name,
          sku: v.sku,
          quantity: i.quantity,
          lineTotal: dollars(l.totalCents),
          insufficientStock,
          alsoReturned: returnedByVariant.get(i.variantId) ?? 0,
        };
      }),
    });
  }),
);

exchangesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = exchangeInput.parse(req.body);
    const user = req.user!;
    const requestHash = crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const settings = await getSettings();
    const money = (cents: number) => formatMoney(cents / 100, settings.currencySymbol);

    const { x, replay } = await prisma.$transaction(
      async (tx) => {
        // Same exchange id: serialise, then replay the stored result. A retry can never create a second exchange.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${input.id}))::text`;
        const existing = await tx.exchange.findUnique({ where: { id: input.id }, include: exchangeInclude });
        if (existing) {
          if (existing.processedById !== user.id || existing.requestHash !== requestHash) {
            throw new HttpError(409, "This exchange id was already used with a different request");
          }
          return { x: existing, replay: true };
        }

        // Different exchanges (or returns) against the same invoice queue here, so an item can never be returned twice.
        const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Sale" WHERE id = ${input.saleId} FOR UPDATE`;
        if (!locked.length) throw new HttpError(404, "Sale not found");

        const register = await tx.register.findUnique({ where: { id: input.registerId } });
        if (!register?.isActive) throw new HttpError(400, "Unknown or inactive register");

        const { sale, computed, total: returned } = await computeReturn(tx, input.saleId, input.returnItems);
        const resellable = new Map(input.returnItems.map((i) => [i.saleItemId, i.resellable]));
        const { byId, priced } = await priceCart(tx, input.newItems, input.discount, user, settings);

        const returnedCents = centsOf(returned);
        const issuedCents = priced.grandTotalCents;
        const diffCents = issuedCents - returnedCents;
        const creditCents = Math.min(returnedCents, issuedCents);

        // ----- settle the difference -----
        const codes = [...new Set([...input.payments, ...input.refunds].map((p) => p.method))];
        const methods = await tx.paymentMethod.findMany({ where: { code: { in: [...codes, "exchange_credit"] } } });
        const methodByCode = new Map(methods.map((m) => [m.code, m]));
        const credit = methodByCode.get("exchange_credit");
        if (!credit) throw new HttpError(500, "Exchange credit method is not configured");
        for (const c of codes) {
          const m = methodByCode.get(c);
          if (!m?.isActive || m.isSystem) throw new HttpError(400, `Unknown or inactive payment method: ${c}`);
        }

        let cashInCents = 0;
        let nonCashInCents = 0;
        let changeCents = 0;
        if (diffCents > 0) {
          if (input.refunds.length) throw new HttpError(400, "The customer owes money on this exchange; refunds are not allowed");
          for (const p of input.payments) {
            const m = methodByCode.get(p.method)!;
            if (m.isCash) cashInCents += toCents(p.amount);
            else {
              if (!p.reference) throw new HttpError(400, `A reference is required for ${m.name} payments`);
              nonCashInCents += toCents(p.amount);
            }
          }
          if (nonCashInCents > diffCents) throw new HttpError(400, "Card and online payments cannot exceed the amount due");
          const tendered = cashInCents + nonCashInCents;
          if (tendered < diffCents) throw new HttpError(402, `Insufficient payment: ${money(diffCents - tendered)} remaining`);
          changeCents = tendered - diffCents;
        } else if (diffCents === 0) {
          if (input.payments.length || input.refunds.length) throw new HttpError(400, "This is an even exchange; no payment or refund is needed");
        } else {
          if (input.payments.length) throw new HttpError(400, "The customer is owed money on this exchange; take no payment");
          const refundCents = input.refunds.reduce((a, r) => a + toCents(r.amount), 0);
          if (refundCents !== -diffCents) {
            throw new HttpError(400, `Refund amounts must add up to ${money(-diffCents)} (got ${money(refundCents)})`);
          }
          // Card/online refunds may only go back to what the original sale was paid with, net of earlier refunds.
          const paid = await tx.salePayment.groupBy({ by: ["methodId"], where: { saleId: sale.id }, _sum: { amount: true } });
          const refundedBefore = await tx.$queryRaw<{ methodId: number; amount: string }[]>`
            SELECT rr."methodId", COALESCE(SUM(rr.amount), 0)::text AS amount
            FROM "ReturnRefund" rr JOIN "SaleReturn" r ON r.id = rr."returnId"
            WHERE r."saleId" = ${sale.id} AND rr.status <> 'FAILED' GROUP BY rr."methodId"`;
          for (const code of new Set(input.refunds.map((r) => r.method))) {
            const m = methodByCode.get(code)!;
            if (m.isCash) continue;
            const want = input.refunds.filter((r) => r.method === code).reduce((a, r) => a.plus(r.amount.toFixed(2)), D(0));
            const room = D(paid.find((p) => p.methodId === m.id)?._sum.amount).minus(D(refundedBefore.find((p) => p.methodId === m.id)?.amount));
            if (want.greaterThan(room)) {
              throw new HttpError(409, `${m.name} refunds cannot exceed ${formatMoney(room.toFixed(2), settings.currencySymbol)} (the amount originally paid that way and not yet refunded)`);
            }
          }
        }

        // The drawer: cash taken or paid out belongs to the open shift on the register.
        const cashInvolved = cashInCents > 0 || input.refunds.some((r) => methodByCode.get(r.method)!.isCash);
        const shiftId = await lockOpenShift(tx, register.id);
        if (settings.requireShift && !shiftId && (cashInvolved || input.newItems.length)) {
          throw new HttpError(409, `Open a shift on ${register.name} before processing an exchange`);
        }

        // ----- stock: one pass in variant order so concurrent exchanges cannot deadlock -----
        const variants = await tx.productVariant.findMany({
          where: { id: { in: computed.map((c) => c.variantId) } },
          include: { product: { select: { trackStock: true } } },
        });
        const trackedReturn = new Map(variants.map((v) => [v.id, v.product.trackStock]));
        const restock = new Map<string, { qty: Prisma.Decimal; cost: Prisma.Decimal }>();
        for (const c of computed) {
          if (!resellable.get(c.saleItemId.toString()) || !trackedReturn.get(c.variantId)) continue;
          const cur = restock.get(c.variantId);
          restock.set(c.variantId, { qty: (cur?.qty ?? D(0)).plus(c.quantity), cost: c.unitCost });
        }
        const deduct = new Map<string, number>();
        input.newItems.forEach((i) => {
          if (byId.get(i.variantId)!.product.trackStock) deduct.set(i.variantId, (deduct.get(i.variantId) ?? 0) + i.quantity);
        });

        // ----- document numbers: fixed order -----
        const next = async (key: string) => {
          const [{ value }] = await tx.$queryRaw<{ value: number }[]>`
            INSERT INTO "DocumentCounter" ("key", "value") VALUES (${key}, 1)
            ON CONFLICT ("key") DO UPDATE SET "value" = "DocumentCounter"."value" + 1
            RETURNING "value"`;
          return String(value).padStart(6, "0");
        };
        const exchangeNumber = `EXC-${await next("exchange")}`;
        const returnNumber = `RET-${await next("return")}`;
        const saleNumber = `INV-${await next("sale")}`;
        const returnId = crypto.randomUUID();
        const newSaleId = crypto.randomUUID();

        const touched = [...new Set([...restock.keys(), ...deduct.keys()])].sort();
        for (const variantId of touched) {
          const r = restock.get(variantId);
          if (r) {
            await recordMovement(
              tx,
              { variantId, type: "RETURN_IN", quantity: r.qty.toNumber(), unitCost: r.cost.toNumber(), referenceType: "return", referenceId: returnId, reason: `${exchangeNumber} (${input.reason})`, userId: user.id },
              true,
            );
          }
          const qty = deduct.get(variantId);
          if (qty) {
            const v = byId.get(variantId)!;
            try {
              await recordMovement(
                tx,
                { variantId, type: "SALE", quantity: -qty, unitCost: Number(v.costPrice), referenceType: "sale", referenceId: newSaleId, reason: exchangeNumber, userId: user.id },
                settings.allowNegativeStock,
              );
            } catch (e) {
              if (e instanceof HttpError && e.status === 409) throw new HttpError(409, `Insufficient stock for ${v.sku}`);
              throw e;
            }
          }
        }

        // ----- the return document -----
        const tax = computed.reduce((a, l) => a.plus(l.taxAmount), D(0));
        const now = new Date();
        const createdReturn = await tx.saleReturn.create({
          data: {
            id: returnId,
            returnNumber,
            saleId: sale.id,
            registerId: register.id,
            shiftId,
            processedById: user.id,
            customerId: sale.customerId,
            reason: input.reason,
            notes: [`Exchange ${exchangeNumber}`, input.notes].filter(Boolean).join(": "),
            subtotal: returned.minus(tax).toFixed(2),
            taxTotal: tax.toFixed(2),
            refundTotal: returned.toFixed(2),
            items: {
              create: computed.map((c) => ({
                saleItemId: c.saleItemId,
                variantId: c.variantId,
                description: c.description,
                sku: c.sku,
                quantity: c.quantity.toString(),
                taxAmount: c.taxAmount.toFixed(2),
                refundAmount: c.refundAmount.toFixed(2),
                discountAmount: c.discountAmount.toFixed(2),
                resellable: !!resellable.get(c.saleItemId.toString()),
                restocked: !!resellable.get(c.saleItemId.toString()) && !!trackedReturn.get(c.variantId),
              })),
            },
            refunds: {
              create: [
                { methodId: credit.id, amount: dollars(creditCents), reference: exchangeNumber, status: "COMPLETED" as const, resolvedById: user.id, resolvedAt: now },
                ...input.refunds.map((r) => {
                  const m = methodByCode.get(r.method)!;
                  return {
                    methodId: m.id,
                    amount: r.amount.toFixed(2),
                    reference: r.reference,
                    status: m.isCash ? ("COMPLETED" as const) : ("PENDING" as const),
                    resolvedById: m.isCash ? user.id : null,
                    resolvedAt: m.isCash ? now : null,
                  };
                }),
              ],
            },
          },
        });

        // ----- the replacement sale -----
        const tendered = cashInCents + nonCashInCents;
        const createdSale = await tx.sale.create({
          data: {
            id: newSaleId,
            saleNumber,
            status: "COMPLETED",
            registerId: register.id,
            cashierId: user.id,
            customerId: sale.customerId,
            shiftId,
            subtotal: dollars(priced.subtotalCents),
            discountTotal: dollars(priced.discountCents),
            taxTotal: dollars(priced.taxCents),
            grandTotal: dollars(issuedCents),
            amountPaid: dollars(creditCents + tendered),
            changeGiven: dollars(changeCents),
            notes: `Exchange ${exchangeNumber} for ${sale.saleNumber}`,
            completedAt: now,
            items: {
              create: input.newItems.map((i, idx) => {
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
              create: [
                { methodId: credit.id, amount: dollars(creditCents), reference: exchangeNumber },
                ...input.payments.map((p) => ({ methodId: methodByCode.get(p.method)!.id, amount: p.amount.toFixed(2), reference: p.reference })),
              ],
            },
          },
        });

        const created = await tx.exchange.create({
          data: {
            id: input.id,
            exchangeNumber,
            originalSaleId: sale.id,
            returnId: createdReturn.id,
            newSaleId: createdSale.id,
            registerId: register.id,
            processedById: user.id,
            returnedValue: returned.toFixed(2),
            issuedValue: dollars(issuedCents),
            difference: dollars(diffCents),
            requestHash,
          },
          include: exchangeInclude,
        });
        return { x: created, replay: false };
      },
      { maxWait: 10_000, timeout: 30_000 },
    );

    if (!replay) {
      await audit(req, "exchange.create", "Exchange", x.id, {
        exchangeNumber: x.exchangeNumber,
        originalSale: x.originalSale.saleNumber,
        returnNumber: x.return.returnNumber,
        newSale: x.newSale.saleNumber,
        returnedValue: x.returnedValue.toString(),
        issuedValue: x.issuedValue.toString(),
        difference: x.difference.toString(),
        reason: x.return.reason,
      });
    }
    res.setHeader("Idempotent-Replay", String(replay));
    res.status(replay ? 200 : 201).json(serializeExchange(x));
  }),
);

exchangesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        saleId: z.string().uuid().optional(),
        search: z.string().trim().min(1).max(40).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
      })
      .parse(req.query);
    const where: Prisma.ExchangeWhereInput = {
      ...(q.saleId ? { originalSaleId: q.saleId } : {}),
      ...(q.search
        ? {
            OR: [
              { exchangeNumber: { contains: q.search, mode: "insensitive" } },
              { originalSale: { saleNumber: { contains: q.search, mode: "insensitive" } } },
            ],
          }
        : {}),
    };
    const [total, rows] = await prisma.$transaction([
      prisma.exchange.count({ where }),
      prisma.exchange.findMany({
        where,
        include: { originalSale: { select: { id: true, saleNumber: true } }, newSale: { select: { id: true, saleNumber: true } }, processedBy: { select: { id: true, fullName: true } } },
        orderBy: { createdAt: "desc" },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    res.json({
      total,
      page: q.page,
      pageSize: q.pageSize,
      items: rows.map(({ requestHash: _h, ...r }) => ({
        ...r,
        returnedValue: D(r.returnedValue).toFixed(2),
        issuedValue: D(r.issuedValue).toFixed(2),
        difference: D(r.difference).toFixed(2),
        direction: direction(D(r.difference)),
      })),
    });
  }),
);

exchangesRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json(serializeExchange(await loadExchange(String(req.params.id))));
  }),
);

exchangesRouter.get(
  "/:id/receipt",
  asyncHandler(async (req, res) => {
    const [x, settings] = await Promise.all([loadExchange(String(req.params.id)), getSettings()]);
    res.json({
      documentType: "EXCHANGE",
      exchangeNumber: x.exchangeNumber,
      issuedAt: x.createdAt,
      originalInvoice: x.originalSale.saleNumber,
      processedBy: x.processedBy.fullName,
      returnedValue: formatMoney(D(x.returnedValue).toFixed(2), settings.currencySymbol),
      issuedValue: formatMoney(D(x.issuedValue).toFixed(2), settings.currencySymbol),
      difference: formatMoney(D(x.difference).abs().toFixed(2), settings.currencySymbol),
      direction: direction(D(x.difference)),
      returned: buildReturnReceipt(x.return, settings),
      issued: buildReceipt(x.newSale, settings),
    });
  }),
);

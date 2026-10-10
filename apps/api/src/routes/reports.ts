import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db.js";
import { asyncHandler, HttpError } from "../middleware/error.js";
import { requireRole } from "../middleware/auth.js";
import { getSettings } from "../services/stock.js";
import { cashSummary, shiftInclude } from "../services/shifts.js";

/**
 * Reports are computed in PostgreSQL with exact NUMERIC arithmetic and returned as 2dp strings.
 * Day, week and month boundaries use the store timezone (BusinessSettings.timezone), never the server's.
 *
 * Revenue (what was sold, less what was refunded) is kept apart from cash collected (what actually
 * moved through payment methods) because change, pending refunds and non-cash methods make them differ.
 */
export const reportsRouter = Router();
reportsRouter.use(requireRole("ADMIN", "MANAGER"));

const D = (v: Prisma.Decimal.Value | null | undefined) => new Prisma.Decimal(v ?? 0);
const money = (v: Prisma.Decimal.Value | null | undefined) => D(v).toFixed(2);
const qty = (v: Prisma.Decimal.Value | null | undefined) => D(v).toString();

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").refine((s) => !Number.isNaN(Date.parse(s)), "Invalid date");
const paging = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
};
const range = { from: dateStr.optional(), to: dateStr.optional() };

/** Local calendar date of "now" in the store timezone, as YYYY-MM-DD. */
const todayIn = (tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());

async function window(q: { from?: string; to?: string }) {
  const settings = await getSettings();
  const tz = settings.timezone;
  const today = todayIn(tz);
  const to = q.to ?? today;
  const from = q.from ?? `${to.slice(0, 8)}01`;
  if (from > to) throw new HttpError(400, "from must not be after to");
  // Stored timestamps are UTC; convert to the store's local time before comparing to the local dates.
  const local = (col: string) => Prisma.raw(`(("${col.split(".").join('"."')}" AT TIME ZONE 'UTC') AT TIME ZONE '${tz.replace(/'/g, "")}')`);
  const between = (col: string) =>
    Prisma.sql`${local(col)} >= ${from}::date AND ${local(col)} < (${to}::date + 1)`;
  return { settings, tz, from, to, local, between };
}

// Each report is registered by name so the CSV/PDF exports run the very same handler (same filters, SQL and rounding) instead of a copy.
const reportHandlers = new Map<string, RequestHandler>();
function reportGet(path: string, handler: RequestHandler) {
  reportHandlers.set(path.slice(1), handler);
  reportsRouter.get(path, handler);
}

type ReportPage = { total?: number; items?: unknown[]; [k: string]: unknown };

/** Runs a report handler in-process and returns its JSON body. */
export function runReport(name: string, query: Record<string, unknown>): Promise<ReportPage> {
  const handler = reportHandlers.get(name);
  if (!handler) return Promise.reject(new HttpError(404, "Unknown report"));
  return new Promise((resolve, reject) => {
    const res = { json: (body: ReportPage) => resolve(body) } as unknown as Response;
    handler({ query } as unknown as Request, res, reject as NextFunction);
  });
}

/** Every page of a paginated report, as one result. */
export async function collectReport(name: string, query: Record<string, unknown>, maxRows = 50_000): Promise<ReportPage> {
  const pageSize = 200;
  const first = await runReport(name, { ...query, page: 1, pageSize });
  if (!Array.isArray(first.items) || first.total === undefined) return first;
  const items = [...first.items];
  for (let page = 2; items.length < Math.min(first.total, maxRows); page++) {
    const next = await runReport(name, { ...query, page, pageSize });
    if (!next.items?.length) break;
    items.push(...next.items);
  }
  return { ...first, items, page: 1, pageSize: items.length };
}
const meta = (w: { tz: string; from: string; to: string }) => ({ timezone: w.tz, from: w.from, to: w.to });

const lowOf = (page: number, size: number) => Prisma.sql`LIMIT ${size} OFFSET ${(page - 1) * size}`;

// ---------- Sales by day / week / month ----------
reportGet(
  "/sales",
  asyncHandler(async (req, res) => {
    const q = z.object({ ...range, groupBy: z.enum(["day", "week", "month"]).default("day"), ...paging }).parse(req.query);
    const w = await window(q);
    const unit = Prisma.raw(`'${q.groupBy}'`);
    const base = Prisma.sql`
      WITH s AS (
        SELECT date_trunc(${unit}, ${w.local('s.createdAt')}) AS period, COUNT(*) AS n,
               SUM(s.subtotal) AS gross, SUM(s."discountTotal") AS discounts, SUM(s."taxTotal") AS tax, SUM(s."grandTotal") AS total
        FROM "Sale" s WHERE s.status = 'COMPLETED' AND ${w.between("s.createdAt")} GROUP BY 1
      ), r AS (
        SELECT date_trunc(${unit}, ${w.local('r.createdAt')}) AS period, COUNT(*) AS n, SUM(r."refundTotal") AS refunds, SUM(r."taxTotal") AS tax
        FROM "SaleReturn" r WHERE ${w.between("r.createdAt")} GROUP BY 1
      ), j AS (
        SELECT COALESCE(s.period, r.period) AS period,
               COALESCE(s.n, 0) AS sales_count, COALESCE(r.n, 0) AS returns_count,
               COALESCE(s.gross, 0) AS gross, COALESCE(s.discounts, 0) AS discounts, COALESCE(s.tax, 0) AS tax,
               COALESCE(s.total, 0) AS sales_total, COALESCE(r.refunds, 0) AS refunds, COALESCE(r.tax, 0) AS refunded_tax
        FROM s FULL OUTER JOIN r ON s.period = r.period
      )`;
    type Row = { period: string; sales_count: bigint; returns_count: bigint; gross: string; discounts: string; tax: string; sales_total: string; refunds: string; net: string; refunded_tax: string };
    const rows = await prisma.$queryRaw<Row[]>(Prisma.sql`${base}
      SELECT to_char(period, 'YYYY-MM-DD') AS period, sales_count, returns_count, gross::text, discounts::text, tax::text,
             sales_total::text, refunds::text, (sales_total - refunds)::text AS net, refunded_tax::text
      FROM j ORDER BY period DESC ${lowOf(q.page, q.pageSize)}`);
    const [t] = await prisma.$queryRaw<(Omit<Row, "period"> & { periods: bigint })[]>(Prisma.sql`${base}
      SELECT COUNT(*) AS periods, COALESCE(SUM(sales_count), 0) AS sales_count, COALESCE(SUM(returns_count), 0) AS returns_count,
             COALESCE(SUM(gross), 0)::text AS gross, COALESCE(SUM(discounts), 0)::text AS discounts, COALESCE(SUM(tax), 0)::text AS tax,
             COALESCE(SUM(sales_total), 0)::text AS sales_total, COALESCE(SUM(refunds), 0)::text AS refunds,
             COALESCE(SUM(sales_total - refunds), 0)::text AS net, COALESCE(SUM(refunded_tax), 0)::text AS refunded_tax
      FROM j`);
    const shape = (r: Omit<Row, "period">) => ({
      salesCount: Number(r.sales_count),
      returnsCount: Number(r.returns_count),
      grossSales: money(r.gross),
      discounts: money(r.discounts),
      tax: money(r.tax),
      salesTotal: money(r.sales_total),
      refunds: money(r.refunds),
      netSales: money(r.net),
    });
    res.json({
      ...meta(w),
      groupBy: q.groupBy,
      definitions: {
        grossSales: "Item prices x quantity before any discount",
        discounts: "Line and cart discounts",
        salesTotal: "Amount invoiced (gross - discounts, plus VAT when added on top)",
        refunds: "Value of returns processed in the period (by return date, not original sale date)",
        netSales: "salesTotal - refunds",
      },
      total: Number(t.periods),
      page: q.page,
      pageSize: q.pageSize,
      totals: shape(t),
      items: rows.map((r) => ({ period: r.period, ...shape(r) })),
    });
  }),
);

// ---------- Payment methods: revenue vs cash collected ----------
reportGet(
  "/payments",
  asyncHandler(async (req, res) => {
    const q = z.object({ ...range }).parse(req.query);
    const w = await window(q);
    const tendered = await prisma.$queryRaw<{ code: string; name: string; isCash: boolean; tendered: string }[]>(Prisma.sql`
      SELECT m.code, m.name, m."isCash", COALESCE(SUM(sp.amount), 0)::text AS tendered
      FROM "PaymentMethod" m
      LEFT JOIN (SELECT sp.* FROM "SalePayment" sp JOIN "Sale" s ON s.id = sp."saleId"
                 WHERE s.status = 'COMPLETED' AND ${w.between("s.createdAt")}) sp ON sp."methodId" = m.id
      WHERE NOT m."isSystem"
      GROUP BY m.id, m.code, m.name, m."isCash" ORDER BY m.id`);
    const refunds = await prisma.$queryRaw<{ code: string; status: string; amount: string }[]>(Prisma.sql`
      SELECT m.code, rr.status::text AS status, COALESCE(SUM(rr.amount), 0)::text AS amount
      FROM "ReturnRefund" rr JOIN "SaleReturn" r ON r.id = rr."returnId" JOIN "PaymentMethod" m ON m.id = rr."methodId"
      WHERE NOT m."isSystem" AND ${w.between("r.createdAt")} GROUP BY m.code, rr.status`);
    const [chg] = await prisma.$queryRaw<{ change: string }[]>(Prisma.sql`
      SELECT COALESCE(SUM(s."changeGiven"), 0)::text AS change FROM "Sale" s WHERE s.status = 'COMPLETED' AND ${w.between("s.createdAt")}`);
    const [rev] = await prisma.$queryRaw<{ sales: string; refunds: string }[]>(Prisma.sql`
      SELECT (SELECT COALESCE(SUM("grandTotal"), 0) FROM "Sale" s WHERE s.status = 'COMPLETED' AND ${w.between("s.createdAt")})::text AS sales,
             (SELECT COALESCE(SUM("refundTotal"), 0) FROM "SaleReturn" r WHERE ${w.between("r.createdAt")})::text AS refunds`);

    const methods = tendered.map((t) => {
      const sum = (status: string) => refunds.filter((r) => r.code === t.code && r.status === status).reduce((a, r) => a.plus(r.amount), D(0));
      const change = t.isCash ? D(chg.change) : D(0);
      const collected = D(t.tendered).minus(change);
      const done = sum("COMPLETED");
      return {
        method: t.code,
        name: t.name,
        isCash: t.isCash,
        tendered: money(t.tendered),
        changeGiven: money(change),
        collected: money(collected),
        refundsCompleted: money(done),
        refundsPending: money(sum("PENDING")),
        refundsFailed: money(sum("FAILED")),
        netCollected: money(collected.minus(done)),
      };
    });
    const totalCollected = methods.reduce((a, m) => a.plus(m.collected), D(0));
    const totalRefundsDone = methods.reduce((a, m) => a.plus(m.refundsCompleted), D(0));
    res.json({
      ...meta(w),
      revenue: { salesTotal: money(rev.sales), refunds: money(rev.refunds), netSales: money(D(rev.sales).minus(rev.refunds)) },
      cash: {
        collectedAllMethods: money(totalCollected),
        refundsPaidOut: money(totalRefundsDone),
        netCollected: money(totalCollected.minus(totalRefundsDone)),
        pendingRefunds: money(methods.reduce((a, m) => a.plus(m.refundsPending), D(0))),
      },
      note: "Revenue is what was sold less what was refunded. Collected is what was received per payment method (cash net of change). They differ by pending refunds and by timing, because refunds are dated when processed.",
      methods,
    });
  }),
);

// ---------- Cashier performance ----------
reportGet(
  "/cashiers",
  asyncHandler(async (req, res) => {
    const q = z.object({ ...range, ...paging }).parse(req.query);
    const w = await window(q);
    const base = Prisma.sql`
      WITH s AS (
        SELECT s."cashierId" AS uid, COUNT(*) AS n, SUM(s.subtotal) AS gross, SUM(s."discountTotal") AS disc, SUM(s."grandTotal") AS total
        FROM "Sale" s WHERE s.status = 'COMPLETED' AND ${w.between("s.createdAt")} GROUP BY 1
      ), i AS (
        SELECT s."cashierId" AS uid, SUM(si.quantity) AS units
        FROM "SaleItem" si JOIN "Sale" s ON s.id = si."saleId" WHERE s.status = 'COMPLETED' AND ${w.between("s.createdAt")} GROUP BY 1
      ), r AS (
        SELECT s."cashierId" AS uid, COUNT(*) AS n, SUM(r."refundTotal") AS refunds
        FROM "SaleReturn" r JOIN "Sale" s ON s.id = r."saleId" WHERE ${w.between("r.createdAt")} GROUP BY 1
      ), j AS (
        SELECT u.id, u."fullName", u.username, s.n AS sales_count, s.gross, s.disc, s.total, i.units, COALESCE(r.n, 0) AS returns_count, COALESCE(r.refunds, 0) AS refunds
        FROM s JOIN "User" u ON u.id = s.uid LEFT JOIN i ON i.uid = s.uid LEFT JOIN r ON r.uid = s.uid
      )`;
    type Row = { id: string; fullName: string; username: string; sales_count: bigint; gross: string; disc: string; total: string; units: string; returns_count: bigint; refunds: string };
    const rows = await prisma.$queryRaw<Row[]>(Prisma.sql`${base}
      SELECT id, "fullName", username, sales_count, gross::text, disc::text, total::text, COALESCE(units, 0)::text AS units, returns_count, refunds::text,
             CASE WHEN sales_count > 0 THEN round(total / sales_count, 2) ELSE 0 END::text AS avg_sale
      FROM j ORDER BY total DESC, "fullName" ${lowOf(q.page, q.pageSize)}`) as (Row & { avg_sale: string })[];
    const [t] = await prisma.$queryRaw<{ n: bigint }[]>(Prisma.sql`${base} SELECT COUNT(*) AS n FROM j`);
    res.json({
      ...meta(w),
      total: Number(t.n),
      page: q.page,
      pageSize: q.pageSize,
      items: rows.map((r) => ({
        cashierId: r.id,
        name: r.fullName,
        username: r.username,
        salesCount: Number(r.sales_count),
        grossSales: money(r.gross),
        discounts: money(r.disc),
        salesTotal: money(r.total),
        averageSale: money(r.avg_sale),
        unitsSold: qty(r.units),
        returnsOnTheirSales: Number(r.returns_count),
        refunds: money(r.refunds),
        netSales: money(D(r.total).minus(r.refunds)),
      })),
    });
  }),
);

// ---------- Product sales ----------
reportGet(
  "/products",
  asyncHandler(async (req, res) => {
    const q = z.object({ ...range, search: z.string().trim().max(60).optional(), ...paging }).parse(req.query);
    const w = await window(q);
    const like = q.search ? `%${q.search.replace(/[%_\\]/g, "\\$&")}%` : null;
    const base = Prisma.sql`
      WITH s AS (
        SELECT si."variantId" AS vid, SUM(si.quantity) AS qty, SUM(si."unitPrice" * si.quantity) AS gross, SUM(si.discount) AS disc,
               SUM(si."lineTotal") AS revenue, SUM(si."unitCost" * si.quantity) AS cost,
               (array_agg(si.description ORDER BY s."createdAt" DESC))[1] AS description, (array_agg(si.sku ORDER BY s."createdAt" DESC))[1] AS sku
        FROM "SaleItem" si JOIN "Sale" s ON s.id = si."saleId" WHERE s.status = 'COMPLETED' AND ${w.between("s.createdAt")} GROUP BY 1
      ), r AS (
        SELECT ri."variantId" AS vid, SUM(ri.quantity) AS qty, SUM(ri."refundAmount") AS refunded,
               (array_agg(ri.description ORDER BY r."createdAt" DESC))[1] AS description, (array_agg(ri.sku ORDER BY r."createdAt" DESC))[1] AS sku
        FROM "ReturnItem" ri JOIN "SaleReturn" r ON r.id = ri."returnId" WHERE ${w.between("r.createdAt")} GROUP BY 1
      ), j AS (
        SELECT COALESCE(s.vid, r.vid) AS vid, COALESCE(s.description, r.description) AS description, COALESCE(s.sku, r.sku) AS sku,
               COALESCE(s.qty, 0) AS qty_sold, COALESCE(r.qty, 0) AS qty_returned,
               COALESCE(s.gross, 0) AS gross, COALESCE(s.disc, 0) AS disc, COALESCE(s.revenue, 0) AS revenue, COALESCE(r.refunded, 0) AS refunded
        FROM s FULL OUTER JOIN r ON s.vid = r.vid
        WHERE ${like ? Prisma.sql`(COALESCE(s.description, r.description) ILIKE ${like} OR COALESCE(s.sku, r.sku) ILIKE ${like})` : Prisma.sql`TRUE`}
      )`;
    type Row = { vid: string; description: string; sku: string; qty_sold: string; qty_returned: string; gross: string; disc: string; revenue: string; refunded: string };
    const rows = await prisma.$queryRaw<Row[]>(Prisma.sql`${base}
      SELECT vid, description, sku, qty_sold::text, qty_returned::text, gross::text, disc::text, revenue::text, refunded::text
      FROM j ORDER BY (revenue - refunded) DESC, sku ${lowOf(q.page, q.pageSize)}`);
    const [t] = await prisma.$queryRaw<{ n: bigint; qty_sold: string; qty_returned: string; revenue: string; refunded: string }[]>(Prisma.sql`${base}
      SELECT COUNT(*) AS n, COALESCE(SUM(qty_sold), 0)::text AS qty_sold, COALESCE(SUM(qty_returned), 0)::text AS qty_returned,
             COALESCE(SUM(revenue), 0)::text AS revenue, COALESCE(SUM(refunded), 0)::text AS refunded FROM j`);
    res.json({
      ...meta(w),
      total: Number(t.n),
      page: q.page,
      pageSize: q.pageSize,
      totals: {
        quantitySold: qty(t.qty_sold),
        quantityReturned: qty(t.qty_returned),
        revenue: money(t.revenue),
        refunded: money(t.refunded),
        netRevenue: money(D(t.revenue).minus(t.refunded)),
      },
      items: rows.map((r) => ({
        variantId: r.vid,
        description: r.description,
        sku: r.sku,
        quantitySold: qty(r.qty_sold),
        quantityReturned: qty(r.qty_returned),
        netQuantity: qty(D(r.qty_sold).minus(r.qty_returned)),
        grossSales: money(r.gross),
        discounts: money(r.disc),
        revenue: money(r.revenue),
        refunded: money(r.refunded),
        netRevenue: money(D(r.revenue).minus(r.refunded)),
      })),
    });
  }),
);

// ---------- Low stock ----------
reportGet(
  "/low-stock",
  asyncHandler(async (req, res) => {
    const q = z.object({ ...paging }).parse(req.query);
    const base = Prisma.sql`
      FROM "ProductVariant" v JOIN "Product" p ON p.id = v."productId" LEFT JOIN "StockLevel" s ON s."variantId" = v.id
      WHERE v."isActive" AND p."isActive" AND p."trackStock" AND COALESCE(s."onHand", 0) <= v."reorderLevel"`;
    const rows = await prisma.$queryRaw<{ variantId: string; sku: string; productName: string; variantName: string | null; reorderLevel: string; onHand: string; shortBy: string }[]>(Prisma.sql`
      SELECT v.id AS "variantId", v.sku, p.name AS "productName", v.name AS "variantName", v."reorderLevel"::text AS "reorderLevel",
             COALESCE(s."onHand", 0)::text AS "onHand", GREATEST(v."reorderLevel" - COALESCE(s."onHand", 0), 0)::text AS "shortBy"
      ${base} ORDER BY COALESCE(s."onHand", 0) - v."reorderLevel", p.name, v.sku ${lowOf(q.page, q.pageSize)}`);
    const [t] = await prisma.$queryRaw<{ n: bigint }[]>(Prisma.sql`SELECT COUNT(*) AS n ${base}`);
    res.json({ total: Number(t.n), page: q.page, pageSize: q.pageSize, items: rows });
  }),
);

// ---------- Tax summary ----------
reportGet(
  "/tax",
  asyncHandler(async (req, res) => {
    const q = z.object({ ...range }).parse(req.query);
    const w = await window(q);
    const incl = w.settings.pricesIncludeTax;
    const sold = await prisma.$queryRaw<{ rate: string; lines: bigint; taxable: string; tax: string; total: string }[]>(Prisma.sql`
      SELECT si."taxRatePct"::text AS rate, COUNT(*) AS lines,
             SUM(CASE WHEN ${incl} THEN si."lineTotal" - si."taxAmount" ELSE si."lineTotal" END)::text AS taxable,
             SUM(si."taxAmount")::text AS tax, SUM(si."lineTotal")::text AS total
      FROM "SaleItem" si JOIN "Sale" s ON s.id = si."saleId"
      WHERE s.status = 'COMPLETED' AND ${w.between("s.createdAt")} GROUP BY si."taxRatePct"`);
    const returned = await prisma.$queryRaw<{ rate: string; taxable: string; tax: string; total: string }[]>(Prisma.sql`
      SELECT si."taxRatePct"::text AS rate,
             SUM(CASE WHEN ${incl} THEN ri."refundAmount" - ri."taxAmount" ELSE ri."refundAmount" END)::text AS taxable,
             SUM(ri."taxAmount")::text AS tax, SUM(ri."refundAmount")::text AS total
      FROM "ReturnItem" ri JOIN "SaleItem" si ON si.id = ri."saleItemId" JOIN "SaleReturn" r ON r.id = ri."returnId"
      WHERE ${w.between("r.createdAt")} GROUP BY si."taxRatePct"`);
    const rates = [...new Set([...sold.map((s) => D(s.rate).toString()), ...returned.map((r) => D(r.rate).toString())])].sort((a, b) => Number(a) - Number(b));
    const items = rates.map((rate) => {
      const s = sold.find((x) => D(x.rate).toString() === rate);
      const r = returned.find((x) => D(x.rate).toString() === rate);
      return {
        ratePct: rate,
        label: Number(rate) === 0 ? "No VAT (0% / zero-rated / exempt / VAT disabled)" : `VAT ${rate}%`,
        taxableSales: money(s?.taxable),
        taxCollected: money(s?.tax),
        taxableReturns: money(r?.taxable),
        taxRefunded: money(r?.tax),
        netTaxableSales: money(D(s?.taxable).minus(D(r?.taxable))),
        netTax: money(D(s?.tax).minus(D(r?.tax))),
      };
    });
    res.json({
      ...meta(w),
      taxEnabled: w.settings.taxEnabled,
      pricesIncludeTax: incl,
      note: "Taxable amounts exclude VAT. Rates come from each sale line's snapshot, so later rate or product changes never alter history.",
      totals: {
        taxCollected: money(items.reduce((a, i) => a.plus(i.taxCollected), D(0))),
        taxRefunded: money(items.reduce((a, i) => a.plus(i.taxRefunded), D(0))),
        netTax: money(items.reduce((a, i) => a.plus(i.netTax), D(0))),
      },
      items,
    });
  }),
);

// ---------- Shift reconciliation ----------
reportGet(
  "/shifts",
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        ...range,
        registerId: z.coerce.number().int().optional(),
        cashierId: z.string().uuid().optional(),
        discrepancyOnly: z.enum(["true", "false"]).optional(),
        ...paging,
      })
      .parse(req.query);
    const w = await window(q);
    const cond = Prisma.sql`${w.between("sh.openedAt")}
      ${q.registerId ? Prisma.sql`AND sh."registerId" = ${q.registerId}` : Prisma.empty}
      ${q.cashierId ? Prisma.sql`AND sh."cashierId" = ${q.cashierId}` : Prisma.empty}
      ${q.discrepancyOnly === "true" ? Prisma.sql`AND sh.variance IS NOT NULL AND sh.variance <> 0` : Prisma.empty}`;
    const ids = await prisma.$queryRaw<{ id: number }[]>(Prisma.sql`
      SELECT sh.id FROM "Shift" sh WHERE ${cond} ORDER BY sh."openedAt" DESC ${lowOf(q.page, q.pageSize)}`);
    const [t] = await prisma.$queryRaw<{ n: bigint; short: string; over: string; unapproved: bigint }[]>(Prisma.sql`
      SELECT COUNT(*) AS n,
             COALESCE(SUM(CASE WHEN sh.variance < 0 THEN sh.variance END), 0)::text AS short,
             COALESCE(SUM(CASE WHEN sh.variance > 0 THEN sh.variance END), 0)::text AS over,
             COUNT(*) FILTER (WHERE sh.discrepancy = 'PENDING_APPROVAL') AS unapproved
      FROM "Shift" sh WHERE ${cond}`);
    const shifts = await prisma.shift.findMany({ where: { id: { in: ids.map((i) => i.id) } }, include: shiftInclude });
    const order = new Map(ids.map((r, i) => [r.id, i]));
    shifts.sort((a, b) => order.get(a.id)! - order.get(b.id)!);

    const items = [];
    for (const s of shifts) {
      const { _expected, ...summary } = await cashSummary(prisma, s.id);
      items.push({
        id: s.id,
        register: s.register.name,
        cashier: s.cashier.fullName,
        openedAt: s.openedAt,
        closedAt: s.closedAt,
        status: s.status,
        ...summary,
        // Closed shifts report the figure frozen at close; open shifts show the live expectation.
        expectedCash: s.expectedCash ? money(s.expectedCash) : summary.expectedCash,
        countedCash: s.countedCash ? money(s.countedCash) : null,
        variance: s.variance ? money(s.variance) : null,
        result: s.variance === null ? "OPEN" : s.variance.isZero() ? "BALANCED" : s.variance.isNegative() ? "SHORTAGE" : "OVERAGE",
        discrepancy: s.discrepancy,
        approvedBy: s.approvedBy?.fullName ?? null,
        approvalNote: s.approvalNote,
      });
    }
    res.json({
      ...meta(w),
      total: Number(t.n),
      page: q.page,
      pageSize: q.pageSize,
      totals: { shortage: money(t.short), overage: money(t.over), net: money(D(t.short).plus(t.over)), awaitingApproval: Number(t.unapproved) },
      items,
    });
  }),
);

// ---------- Refunds ----------
reportGet(
  "/refunds",
  asyncHandler(async (req, res) => {
    const q = z.object({ ...range, ...paging }).parse(req.query);
    const w = await window(q);
    const cond = w.between("r.createdAt");
    const rows = await prisma.$queryRaw<
      { returnNumber: string; created: string; invoice: string; reason: string; processedBy: string; refundTotal: string; taxTotal: string; methods: string; exchange: string | null }[]
    >(Prisma.sql`
      SELECT r."returnNumber", to_char(${w.local("r.createdAt")}, 'YYYY-MM-DD HH24:MI') AS created, s."saleNumber" AS invoice, r.reason::text AS reason,
             u."fullName" AS "processedBy", r."refundTotal"::text AS "refundTotal", r."taxTotal"::text AS "taxTotal",
             (SELECT string_agg(m.name || ' ' || rr.amount::text || ' ' || rr.status::text, '; ' ORDER BY rr.id)
                FROM "ReturnRefund" rr JOIN "PaymentMethod" m ON m.id = rr."methodId" WHERE rr."returnId" = r.id) AS methods,
             (SELECT x."exchangeNumber" FROM "Exchange" x WHERE x."returnId" = r.id) AS exchange
      FROM "SaleReturn" r JOIN "Sale" s ON s.id = r."saleId" JOIN "User" u ON u.id = r."processedById"
      WHERE ${cond} ORDER BY r."createdAt" DESC, r."returnNumber" DESC ${lowOf(q.page, q.pageSize)}`);
    const [t] = await prisma.$queryRaw<{ n: bigint; refunds: string; tax: string; pending: string }[]>(Prisma.sql`
      SELECT COUNT(*) AS n, COALESCE(SUM(r."refundTotal"), 0)::text AS refunds, COALESCE(SUM(r."taxTotal"), 0)::text AS tax,
             COALESCE((SELECT SUM(rr.amount) FROM "ReturnRefund" rr JOIN "SaleReturn" r2 ON r2.id = rr."returnId"
                       WHERE rr.status = 'PENDING' AND ${w.between("r2.createdAt")}), 0)::text AS pending
      FROM "SaleReturn" r WHERE ${cond}`);
    res.json({
      ...meta(w),
      total: Number(t.n),
      page: q.page,
      pageSize: q.pageSize,
      totals: { refunds: money(t.refunds), tax: money(t.tax), pendingExternalRefunds: money(t.pending) },
      items: rows.map((r) => ({
        returnNumber: r.returnNumber,
        date: r.created,
        invoice: r.invoice,
        reason: r.reason,
        processedBy: r.processedBy,
        refundTotal: money(r.refundTotal),
        taxRefunded: money(r.taxTotal),
        refundMethods: r.methods ?? "",
        exchange: r.exchange ?? "",
      })),
    });
  }),
);

// ---------- Inventory (stock on hand and valuation) ----------
reportGet(
  "/inventory",
  asyncHandler(async (req, res) => {
    const q = z.object({ search: z.string().trim().max(60).optional(), ...paging }).parse(req.query);
    const like = q.search ? `%${q.search.replace(/[%_\\]/g, "\\$&")}%` : null;
    const where = Prisma.sql`WHERE v."isActive" AND p."isActive" AND p."trackStock"
      ${like ? Prisma.sql`AND (p.name ILIKE ${like} OR v.sku ILIKE ${like})` : Prisma.empty}`;
    const from = Prisma.sql`FROM "ProductVariant" v JOIN "Product" p ON p.id = v."productId" LEFT JOIN "StockLevel" s ON s."variantId" = v.id`;
    const rows = await prisma.$queryRaw<
      { sku: string; product: string; variant: string | null; onHand: string; reorder: string; cost: string; price: string; costValue: string; retailValue: string; status: string }[]
    >(Prisma.sql`
      SELECT v.sku, p.name AS product, v.name AS variant, COALESCE(s."onHand", 0)::text AS "onHand", v."reorderLevel"::text AS reorder,
             v."costPrice"::text AS cost, v."sellPrice"::text AS price,
             (COALESCE(s."onHand", 0) * v."costPrice")::text AS "costValue", (COALESCE(s."onHand", 0) * v."sellPrice")::text AS "retailValue",
             CASE WHEN COALESCE(s."onHand", 0) <= 0 THEN 'OUT' WHEN COALESCE(s."onHand", 0) <= v."reorderLevel" THEN 'LOW' ELSE 'OK' END AS status
      ${from} ${where} ORDER BY p.name, v.sku ${lowOf(q.page, q.pageSize)}`);
    const [t] = await prisma.$queryRaw<{ n: bigint; units: string; cost: string; retail: string }[]>(Prisma.sql`
      SELECT COUNT(*) AS n, COALESCE(SUM(GREATEST(COALESCE(s."onHand", 0), 0)), 0)::text AS units,
             COALESCE(SUM(GREATEST(COALESCE(s."onHand", 0), 0) * v."costPrice"), 0)::text AS cost,
             COALESCE(SUM(GREATEST(COALESCE(s."onHand", 0), 0) * v."sellPrice"), 0)::text AS retail
      ${from} ${where}`);
    res.json({
      timezone: (await getSettings()).timezone,
      total: Number(t.n),
      page: q.page,
      pageSize: q.pageSize,
      totals: { units: qty(t.units), valueAtCost: money(t.cost), valueAtRetail: money(t.retail) },
      items: rows.map((r) => ({
        sku: r.sku,
        product: r.product,
        variant: r.variant ?? "",
        onHand: qty(r.onHand),
        reorderLevel: qty(r.reorder),
        status: r.status,
        costPrice: money(r.cost),
        sellPrice: money(r.price),
        stockValueAtCost: money(r.costValue),
        stockValueAtRetail: money(r.retailValue),
      })),
    });
  }),
);
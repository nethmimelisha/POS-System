import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { asyncHandler, HttpError } from "../middleware/error.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { audit } from "../services/audit.js";
import { getSettings } from "../services/stock.js";
import { collectReport } from "./reports.js";
import { renderPdf, toCsv, type Column, type Row } from "../services/exportFormats.js";

export const exportsRouter = Router();
exportsRouter.use(requireAuth, requireRole("ADMIN", "MANAGER"));

const m = (key: string, label: string): Column => ({ key, label, type: "money" });
const q = (key: string, label: string): Column => ({ key, label, type: "qty" });
const t = (key: string, label: string): Column => ({ key, label });

interface Spec {
  title: string;
  report?: string; // reuses the matching /reports/<name> handler
  columns: Column[];
  totalsLabels?: Record<string, string>;
}

const SPECS: Record<string, Spec> = {
  sales: {
    title: "Sales Report",
    report: "sales",
    columns: [t("period", "Period"), q("salesCount", "Sales"), q("returnsCount", "Returns"), m("grossSales", "Gross sales"), m("discounts", "Discounts"), m("tax", "Tax"), m("salesTotal", "Sales total"), m("refunds", "Refunds"), m("netSales", "Net sales")],
  },
  refunds: {
    title: "Refund Report",
    report: "refunds",
    columns: [t("returnNumber", "Return"), t("date", "Date"), t("invoice", "Invoice"), t("reason", "Reason"), t("processedBy", "Processed by"), m("refundTotal", "Refund total"), m("taxRefunded", "Tax refunded"), t("refundMethods", "Refund methods"), t("exchange", "Exchange")],
  },
  inventory: {
    title: "Inventory Report",
    report: "inventory",
    columns: [t("sku", "SKU"), t("product", "Product"), t("variant", "Variant"), q("onHand", "On hand"), q("reorderLevel", "Reorder level"), t("status", "Status"), m("costPrice", "Cost price"), m("sellPrice", "Sell price"), m("stockValueAtCost", "Value at cost"), m("stockValueAtRetail", "Value at retail")],
  },
  shifts: {
    title: "Cashier Shift Report",
    report: "shifts",
    columns: [t("id", "Shift"), t("register", "Register"), t("cashier", "Cashier"), t("openedAt", "Opened"), t("closedAt", "Closed"), t("status", "Status"), m("openingCash", "Opening"), m("netCashSales", "Net cash sales"), m("cashIn", "Cash in"), m("cashOut", "Cash out"), m("cashRefunds", "Cash refunds"), m("expectedCash", "Expected"), m("countedCash", "Counted"), m("variance", "Variance"), t("result", "Result"), t("approvedBy", "Approved by")],
  },
  tax: {
    title: "Tax Report",
    report: "tax",
    columns: [t("label", "Rate"), m("taxableSales", "Taxable sales"), m("taxCollected", "Tax collected"), m("taxableReturns", "Taxable returns"), m("taxRefunded", "Tax refunded"), m("netTaxableSales", "Net taxable"), m("netTax", "Net tax")],
  },
  products: {
    title: "Product List",
    columns: [t("sku", "SKU"), t("product", "Product"), t("variant", "Variant"), t("category", "Category"), t("brand", "Brand"), t("barcodes", "Barcodes"), t("unit", "Unit"), m("costPrice", "Cost price"), m("sellPrice", "Sell price"), q("onHand", "On hand"), q("reorderLevel", "Reorder level"), t("active", "Active")],
  },
};

const FILTERS = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  groupBy: z.string().optional(),
  registerId: z.string().optional(),
  search: z.string().optional(),
});

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v);

async function productRows(search?: string): Promise<Row[]> {
  const like = search?.trim();
  const variants = await prisma.productVariant.findMany({
    where: like
      ? { OR: [{ sku: { contains: like, mode: "insensitive" } }, { product: { name: { contains: like, mode: "insensitive" } } }, { barcodes: { some: { barcode: like } } }] }
      : undefined,
    include: { product: { include: { category: true, brand: true } }, barcodes: true, stockLevel: true },
    orderBy: [{ product: { name: "asc" } }, { sku: "asc" }],
    take: 50_000,
  });
  return variants.map((v) => ({
    sku: v.sku,
    product: v.product.name,
    variant: v.name ?? "",
    category: v.product.category?.name ?? "",
    brand: v.product.brand?.name ?? "",
    barcodes: v.barcodes.map((b) => b.barcode).join(" "),
    unit: v.product.unit,
    costPrice: v.costPrice.toFixed(2),
    sellPrice: v.sellPrice.toFixed(2),
    onHand: v.stockLevel ? v.stockLevel.onHand.toFixed(3) : "0.000",
    reorderLevel: v.reorderLevel.toFixed(3),
    active: v.isActive && v.product.isActive ? "Yes" : "No",
  }));
}

function totalsOf(body: Record<string, unknown>): [string, string][] {
  const totals = body.totals;
  if (!totals || typeof totals !== "object") return [];
  return Object.entries(totals as Record<string, unknown>).map(([k, v]) => [k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()), String(v)]);
}

exportsRouter.get(
  "/:report.:format",
  asyncHandler(async (req, res) => {
    const name = String(req.params.report);
    const format = String(req.params.format);
    const spec = SPECS[name];
    if (!spec || (format !== "csv" && format !== "pdf")) throw new HttpError(404, "Unknown export");
    const filters = FILTERS.parse(req.query);

    let rows: Row[];
    let body: Record<string, unknown> = {};
    if (spec.report) {
      body = await collectReport(spec.report, filters);
      rows = ((body.items as Row[]) ?? []).map((r) => ({ ...r, openedAt: iso(r.openedAt), closedAt: iso(r.closedAt) }));
    } else {
      rows = await productRows(filters.search);
    }

    const settings = await getSettings();
    const stamp = new Date().toISOString().slice(0, 10);
    const period = body.from ? `${body.from}_to_${body.to}` : stamp;
    const filename = `${name}-${period}.${format}`;

    await audit(req, "export.download", "report", name, { format, rows: rows.length, filters });

    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (format === "csv") {
      res.type("text/csv; charset=utf-8").send(toCsv(spec.columns, rows));
      return;
    }
    const pdf = await renderPdf({
      title: spec.title,
      business: settings.name,
      subtitle: [
        ...(body.from ? [`Period: ${body.from} to ${body.to} (${body.timezone})`] : []),
        `Generated: ${new Date().toISOString()} by ${req.user?.fullName ?? ""}`,
        `Amounts in ${settings.currencyCode}`,
      ],
      columns: spec.columns,
      rows,
      totals: totalsOf(body),
    });
    res.type("application/pdf").send(pdf);
  }),
);

import type { BusinessSettings } from "@prisma/client";
import type { SaleWithRelations } from "./saleView.js";

export function formatMoney(value: number | string | { toString(): string }, symbol: string): string {
  const n = Number(value.toString());
  return `${symbol} ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function buildReceipt(sale: SaleWithRelations, settings: BusinessSettings) {
  const m = (v: Parameters<typeof formatMoney>[0]) => formatMoney(v, settings.currencySymbol);
  const taxed = Number(sale.taxTotal) > 0;

  const taxSummary = new Map<string, { ratePct: number; taxable: number; tax: number }>();
  for (const i of sale.items) {
    const rate = Number(i.taxRatePct);
    if (rate <= 0) continue;
    const key = String(rate);
    const entry = taxSummary.get(key) ?? { ratePct: rate, taxable: 0, tax: 0 };
    const tax = Number(i.taxAmount);
    const total = Number(i.lineTotal);
    entry.tax += tax;
    // Taxable value excludes the tax itself whether or not it was included in the price.
    entry.taxable += settings.pricesIncludeTax ? total - tax : total;
    taxSummary.set(key, entry);
  }

  return {
    invoiceNumber: sale.saleNumber,
    status: sale.status,
    issuedAt: sale.completedAt ?? sale.createdAt,
    currency: { code: settings.currencyCode, symbol: settings.currencySymbol },
    business: {
      name: settings.name,
      address: settings.address,
      phone: settings.phone,
      // The VAT number is only printed on sales that actually carry VAT.
      vatNumber: taxed ? settings.vatNumber : null,
    },
    header: settings.receiptHeader,
    footer: settings.receiptFooter,
    cashier: sale.cashier.fullName,
    register: sale.register?.name ?? null,
    customer: sale.customer ? { name: sale.customer.name, phone: sale.customer.phone } : null,
    items: sale.items.map((i) => ({
      description: i.description,
      sku: i.sku,
      quantity: Number(i.quantity),
      unitPrice: m(i.unitPrice),
      discount: Number(i.discount) > 0 ? m(i.discount) : null,
      lineTotal: m(i.lineTotal),
    })),
    totals: {
      subtotal: m(sale.subtotal),
      discount: m(sale.discountTotal),
      tax: taxed ? m(sale.taxTotal) : null,
      grandTotal: m(sale.grandTotal),
      paid: m(sale.amountPaid),
      change: m(sale.changeGiven),
    },
    tax: taxed
      ? {
          note: settings.pricesIncludeTax ? "Prices include VAT" : "VAT added to prices",
          breakdown: [...taxSummary.values()].map((t) => ({
            ratePct: t.ratePct,
            taxableAmount: m(t.taxable.toFixed(2)),
            taxAmount: m(t.tax.toFixed(2)),
          })),
        }
      : null,
    payments: sale.payments.map((p) => ({
      method: p.method.name,
      amount: m(p.amount),
      reference: p.reference,
    })),
  };
}

type ReturnForReceipt = {
  returnNumber: string;
  createdAt: Date;
  reason: string;
  notes: string | null;
  taxTotal: { toString(): string };
  refundTotal: { toString(): string };
  sale: { saleNumber: string };
  processedBy: { fullName: string };
  register: { name: string } | null;
  customer: { name: string; phone: string | null } | null;
  items: { description: string; sku: string; quantity: { toString(): string }; refundAmount: { toString(): string }; resellable: boolean }[];
  refunds: { amount: { toString(): string }; status: string; reference: string | null; providerReference: string | null; method: { name: string; isCash: boolean } }[];
};

export function buildReturnReceipt(ret: ReturnForReceipt, settings: BusinessSettings) {
  const m = (v: Parameters<typeof formatMoney>[0]) => formatMoney(v, settings.currencySymbol);
  const taxed = Number(ret.taxTotal) > 0;
  return {
    documentType: "REFUND",
    refundNumber: ret.returnNumber,
    originalInvoice: ret.sale.saleNumber,
    issuedAt: ret.createdAt,
    currency: { code: settings.currencyCode, symbol: settings.currencySymbol },
    business: {
      name: settings.name,
      address: settings.address,
      phone: settings.phone,
      vatNumber: taxed ? settings.vatNumber : null,
    },
    processedBy: ret.processedBy.fullName,
    register: ret.register?.name ?? null,
    customer: ret.customer ? { name: ret.customer.name, phone: ret.customer.phone } : null,
    reason: ret.reason,
    notes: ret.notes,
    items: ret.items.map((i) => ({
      description: i.description,
      sku: i.sku,
      quantity: Number(i.quantity),
      refundAmount: m(i.refundAmount),
    })),
    totals: { tax: taxed ? m(ret.taxTotal) : null, refundTotal: m(ret.refundTotal) },
    refunds: ret.refunds.map((r) => ({
      method: r.method.name,
      amount: m(r.amount),
      status: r.status,
      // Card and online refunds are only a request until the provider confirms them.
      statusNote:
        r.status === "PENDING"
          ? "Awaiting payment provider confirmation"
          : r.status === "FAILED"
            ? "Refund failed - not paid"
            : r.method.isCash
              ? "Paid in cash"
              : "Confirmed by provider",
      reference: r.providerReference ?? r.reference,
    })),
  };
}

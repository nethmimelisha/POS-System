import { useState, type ReactNode } from "react";
import { keepPreviousData, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { api } from "@/api";
import { errorMessage } from "@/api/client";
import { Alert, Badge, Card, EmptyState, ErrorState, LoadingBlock, PageHeader, Stat } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import { Pager } from "@/components/ui/Pager";
import { formatDateTime, formatMoney, formatQty } from "@/lib/format";

type Tab = "sales" | "payments" | "cashiers" | "products" | "tax" | "low-stock" | "shifts";
const TABS: { id: Tab; label: string }[] = [
  { id: "sales", label: "Sales" },
  { id: "payments", label: "Payments" },
  { id: "cashiers", label: "Cashiers" },
  { id: "products", label: "Products" },
  { id: "tax", label: "Tax" },
  { id: "low-stock", label: "Low stock" },
  { id: "shifts", label: "Shift reconciliation" },
];

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const PAGE = 25;

import { ExportBar } from "./ExportBar";
export function ReportsPage() {
  const [tab, setTab] = useState<Tab>("sales");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const range = { from: from || undefined, to: to || undefined };
  const preset = (days: number | "month") => {
    const now = new Date();
    const start = days === "month" ? new Date(now.getFullYear(), now.getMonth(), 1) : new Date(now.getTime() - (days - 1) * 86_400_000);
    setFrom(ymd(start));
    setTo(ymd(now));
  };
  const invalidRange = !!from && !!to && from > to;

  return (
    <div className="mx-auto max-w-6xl p-4 lg:p-8">
      <PageHeader title="Reports" subtitle="Calculated on the server in the store's timezone. Revenue and cash collected are reported separately." />
      <Card className="mb-5 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <Input label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <Input label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          <Button variant="secondary" onClick={() => preset(1)}>
            Today
          </Button>
          <Button variant="secondary" onClick={() => preset(7)}>
            Last 7 days
          </Button>
          <Button variant="secondary" onClick={() => preset("month")}>
            This month
          </Button>
          {(from || to) && (
            <Button variant="ghost" onClick={() => (setFrom(""), setTo(""))}>
              Reset
            </Button>
          )}
        </div>
        {invalidRange && (
          <div className="mt-3">
            <Alert>The start date must not be after the end date.</Alert>
          </div>
        )}
      </Card>
      <ExportBar from={range.from} to={range.to} disabled={invalidRange} />
      <div className="mb-5 flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={`h-9 rounded-md px-3 text-sm font-medium ${tab === t.id ? "bg-white text-navy-900 shadow-sm" : "text-slate-500"}`}>
            {t.label}
          </button>
        ))}
      </div>
      {invalidRange ? null : (
        <>
          {tab === "sales" && <SalesTab {...range} />}
          {tab === "payments" && <PaymentsTab {...range} />}
          {tab === "cashiers" && <CashiersTab {...range} />}
          {tab === "products" && <ProductsTab {...range} />}
          {tab === "tax" && <TaxTab {...range} />}
          {tab === "low-stock" && <LowStockTab />}
          {tab === "shifts" && <ShiftsTab {...range} />}
        </>
      )}
    </div>
  );
}

type Range = { from?: string; to?: string };

function Frame<T>({ q, children }: { q: UseQueryResult<T>; children: (d: T) => ReactNode }) {
  if (q.isPending) return <LoadingBlock />;
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />;
  return <>{children(q.data)}</>;
}

const Period = ({ from, to, tz }: { from?: string; to?: string; tz?: string }) => (
  <p className="mb-3 text-xs text-slate-500">
    {from} to {to} · timezone {tz}
  </p>
);

const th = "px-4 py-3";
const Table = ({ head, children, testId }: { head: [string, boolean?][]; children: ReactNode; testId?: string }) => (
  <Card className="overflow-hidden">
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm" data-testid={testId}>
        <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
          <tr>
            {head.map(([h, right]) => (
              <th key={h} className={`${th} ${right ? "text-right" : ""}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">{children}</tbody>
      </table>
    </div>
  </Card>
);
const N = ({ children, strong }: { children: ReactNode; strong?: boolean }) => <td className={`num px-4 py-3 text-right ${strong ? "font-semibold" : ""}`}>{children}</td>;

function SalesTab(range: Range) {
  const [groupBy, setGroupBy] = useState<"day" | "week" | "month">("day");
  const q = useQuery({ queryKey: ["report", "sales", range, groupBy], queryFn: () => api.reportSales({ ...range, groupBy }), placeholderData: keepPreviousData });
  return (
    <Frame q={q}>
      {(d) => (
        <div data-testid="report-sales">
          <div className="mb-3 flex items-end justify-between">
            <Period from={d.from} to={d.to} tz={d.timezone} />
            <div className="w-36">
              <Select aria-label="Group by" value={groupBy} onChange={(e) => setGroupBy(e.target.value as typeof groupBy)}>
                <option value="day">Daily</option>
                <option value="week">Weekly</option>
                <option value="month">Monthly</option>
              </Select>
            </div>
          </div>
          <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Gross sales" value={formatMoney(d.totals.grossSales)} hint="Before discounts" />
            <Stat label="Discounts" value={formatMoney(d.totals.discounts)} />
            <Stat label="Refunds" value={formatMoney(d.totals.refunds)} hint={`${d.totals.returnsCount} returns`} />
            <Stat label="Net sales" value={formatMoney(d.totals.netSales)} hint={`${d.totals.salesCount} sales`} />
          </div>
          {d.items.length === 0 ? (
            <Card>
              <EmptyState title="No sales in this period" />
            </Card>
          ) : (
            <Table head={[["Period"], ["Sales", true], ["Gross", true], ["Discounts", true], ["Tax", true], ["Sales total", true], ["Refunds", true], ["Net sales", true]]}>
              {d.items.map((r) => (
                <tr key={r.period}>
                  <td className="px-4 py-3 font-medium">{String(r.period).slice(0, 10)}</td>
                  <N>{r.salesCount}</N>
                  <N>{formatMoney(r.grossSales)}</N>
                  <N>{formatMoney(r.discounts)}</N>
                  <N>{formatMoney(r.tax)}</N>
                  <N>{formatMoney(r.salesTotal)}</N>
                  <N>{formatMoney(r.refunds)}</N>
                  <N strong>{formatMoney(r.netSales)}</N>
                </tr>
              ))}
            </Table>
          )}
        </div>
      )}
    </Frame>
  );
}

function PaymentsTab(range: Range) {
  const q = useQuery({ queryKey: ["report", "payments", range], queryFn: () => api.reportPayments(range) });
  return (
    <Frame q={q}>
      {(d) => (
        <div data-testid="report-payments">
          <Period from={d.from} to={d.to} tz={d.timezone} />
          <div className="mb-5 grid gap-4 sm:grid-cols-3">
            <Stat label="Sales revenue" value={formatMoney(d.revenue.salesTotal)} hint="What was sold" />
            <Stat label="Refunds" value={formatMoney(d.revenue.refunds)} />
            <Stat label="Net sales" value={formatMoney(d.revenue.netSales)} />
          </div>
          <Alert tone="navy">{d.note}</Alert>
          <div className="mt-4">
            <Table head={[["Method"], ["Collected", true], ["Refunds paid", true], ["Refunds pending", true], ["Net collected", true]]}>
              {d.methods.map((m) => (
                <tr key={m.method}>
                  <td className="px-4 py-3 font-medium">
                    {m.name} {m.isCash && <Badge tone="navy">cash drawer</Badge>}
                  </td>
                  <N>{formatMoney(m.collected)}</N>
                  <N>{formatMoney(m.refundsCompleted)}</N>
                  <N>{formatMoney(m.refundsPending)}</N>
                  <N strong>{formatMoney(m.netCollected)}</N>
                </tr>
              ))}
            </Table>
          </div>
        </div>
      )}
    </Frame>
  );
}

function CashiersTab(range: Range) {
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ["report", "cashiers", range, page], queryFn: () => api.reportCashiers({ ...range, page }), placeholderData: keepPreviousData });
  return (
    <Frame q={q}>
      {(d) => (
        <div data-testid="report-cashiers">
          <Period from={d.from} to={d.to} tz={d.timezone} />
          {d.items.length === 0 ? (
            <Card>
              <EmptyState title="No sales in this period" />
            </Card>
          ) : (
            <>
              <Table head={[["Cashier"], ["Sales", true], ["Units", true], ["Avg sale", true], ["Discounts", true], ["Sales total", true], ["Refunds", true], ["Net", true]]}>
                {d.items.map((r) => (
                  <tr key={r.cashierId}>
                    <td className="px-4 py-3 font-medium">{r.name}</td>
                    <N>{r.salesCount}</N>
                    <N>{formatQty(r.unitsSold)}</N>
                    <N>{formatMoney(r.averageSale)}</N>
                    <N>{formatMoney(r.discounts)}</N>
                    <N>{formatMoney(r.salesTotal)}</N>
                    <N>{formatMoney(r.refunds)}</N>
                    <N strong>{formatMoney(r.netSales)}</N>
                  </tr>
                ))}
              </Table>
              <Pager page={page} total={d.total} pageSize={PAGE} onPage={setPage} />
            </>
          )}
        </div>
      )}
    </Frame>
  );
}

function ProductsTab(range: Range) {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const q = useQuery({ queryKey: ["report", "products", range, search, page], queryFn: () => api.reportProducts({ ...range, search: search.trim() || undefined, page }), placeholderData: keepPreviousData });
  return (
    <div data-testid="report-products">
      <div className="mb-3 max-w-sm">
        <Input aria-label="Search products" placeholder="Filter by name or SKU" value={search} onChange={(e) => (setSearch(e.target.value), setPage(1))} />
      </div>
      <Frame q={q}>
        {(d) =>
          d.items.length === 0 ? (
            <Card>
              <EmptyState title="No product sales found" />
            </Card>
          ) : (
            <>
              <Table head={[["Product"], ["Sold", true], ["Returned", true], ["Net qty", true], ["Revenue", true], ["Refunded", true], ["Net revenue", true]]}>
                {d.items.map((r) => (
                  <tr key={r.sku}>
                    <td className="px-4 py-3">
                      <div className="font-medium">{r.description}</div>
                      <div className="text-xs text-slate-500">{r.sku}</div>
                    </td>
                    <N>{formatQty(r.quantitySold)}</N>
                    <N>{formatQty(r.quantityReturned)}</N>
                    <N>{formatQty(r.netQuantity)}</N>
                    <N>{formatMoney(r.revenue)}</N>
                    <N>{formatMoney(r.refunded)}</N>
                    <N strong>{formatMoney(r.netRevenue)}</N>
                  </tr>
                ))}
              </Table>
              <Pager page={page} total={d.total} pageSize={PAGE} onPage={setPage} />
            </>
          )
        }
      </Frame>
    </div>
  );
}

function TaxTab(range: Range) {
  const q = useQuery({ queryKey: ["report", "tax", range], queryFn: () => api.reportTax(range) });
  return (
    <Frame q={q}>
      {(d) => (
        <div data-testid="report-tax" className="space-y-4">
          <Period from={d.from} to={d.to} tz={d.timezone} />
          {!d.taxEnabled && <Alert tone="amber">VAT is currently disabled in Settings, so new sales carry no tax. Earlier sales are reported from their saved snapshots.</Alert>}
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat label="Tax collected" value={formatMoney(d.totals.taxCollected)} />
            <Stat label="Tax refunded" value={formatMoney(d.totals.taxRefunded)} />
            <Stat label="Net tax" value={formatMoney(d.totals.netTax)} />
          </div>
          {d.items.length > 0 && (
            <Table head={[["Rate"], ["Taxable sales", true], ["Tax collected", true], ["Taxable returns", true], ["Tax refunded", true], ["Net tax", true]]}>
              {d.items.map((r) => (
                <tr key={r.ratePct}>
                  <td className="px-4 py-3 font-medium">{r.label}</td>
                  <N>{formatMoney(r.taxableSales)}</N>
                  <N>{formatMoney(r.taxCollected)}</N>
                  <N>{formatMoney(r.taxableReturns)}</N>
                  <N>{formatMoney(r.taxRefunded)}</N>
                  <N strong>{formatMoney(r.netTax)}</N>
                </tr>
              ))}
            </Table>
          )}
          <p className="text-xs text-slate-500">{d.note}</p>
        </div>
      )}
    </Frame>
  );
}

function LowStockTab() {
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ["report", "low-stock", page], queryFn: () => api.reportLowStock(page), placeholderData: keepPreviousData });
  return (
    <Frame q={q}>
      {(d) =>
        d.items.length === 0 ? (
          <Card>
            <EmptyState title="Nothing is below its reorder level" />
          </Card>
        ) : (
          <div data-testid="report-low-stock">
            <Table head={[["Product"], ["SKU"], ["On hand", true], ["Reorder level", true], ["Short by", true]]}>
              {d.items.map((r) => (
                <tr key={r.variantId}>
                  <td className="px-4 py-3 font-medium">{r.variantName ? `${r.productName} – ${r.variantName}` : r.productName}</td>
                  <td className="px-4 py-3 text-slate-600">{r.sku}</td>
                  <N>{formatQty(r.onHand)}</N>
                  <N>{formatQty(r.reorderLevel)}</N>
                  <N strong>{formatQty(r.shortBy)}</N>
                </tr>
              ))}
            </Table>
            <Pager page={page} total={d.total} pageSize={PAGE} onPage={setPage} />
          </div>
        )
      }
    </Frame>
  );
}

const RESULT_TONE = { OPEN: "green", BALANCED: "slate", SHORTAGE: "red", OVERAGE: "amber" } as const;

function ShiftsTab(range: Range) {
  const [page, setPage] = useState(1);
  const [only, setOnly] = useState(false);
  const q = useQuery({ queryKey: ["report", "shifts", range, page, only], queryFn: () => api.reportShifts({ ...range, page, discrepancyOnly: only || undefined }), placeholderData: keepPreviousData });
  return (
    <Frame q={q}>
      {(d) => (
        <div data-testid="report-shifts" className="space-y-4">
          <Period from={d.from} to={d.to} tz={d.timezone} />
          <div className="grid gap-4 sm:grid-cols-4">
            <Stat label="Shortages" value={formatMoney(d.totals.shortage)} />
            <Stat label="Overages" value={formatMoney(d.totals.overage)} />
            <Stat label="Net variance" value={formatMoney(d.totals.net)} />
            <Stat label="Awaiting approval" value={d.totals.awaitingApproval} />
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" className="size-4 accent-navy-900" checked={only} onChange={(e) => (setOnly(e.target.checked), setPage(1))} />
            Discrepancies only
          </label>
          {d.items.length === 0 ? (
            <Card>
              <EmptyState title="No shifts in this period" />
            </Card>
          ) : (
            <>
              <Table head={[["Shift"], ["Opened"], ["Cash sales", true], ["Cash in/out", true], ["Cash refunds", true], ["Expected", true], ["Counted", true], ["Variance", true], ["Result"]]}>
                {d.items.map((r) => (
                  <tr key={r.id}>
                    <td className="px-4 py-3">
                      <div className="font-medium">{r.register}</div>
                      <div className="text-xs text-slate-500">{r.cashier}</div>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{formatDateTime(r.openedAt)}</td>
                    <N>{formatMoney(r.netCashSales)}</N>
                    <N>
                      {formatMoney(r.cashIn)} / {formatMoney(r.cashOut)}
                    </N>
                    <N>{formatMoney(r.cashRefunds)}</N>
                    <N>{formatMoney(r.expectedCash)}</N>
                    <N>{r.countedCash ? formatMoney(r.countedCash) : "—"}</N>
                    <N strong>{r.variance ? formatMoney(r.variance) : "—"}</N>
                    <td className="px-4 py-3">
                      <Badge tone={RESULT_TONE[r.result]}>{r.result.toLowerCase()}</Badge>
                      {r.discrepancy === "PENDING_APPROVAL" && (
                        <div className="mt-1">
                          <Badge tone="amber">needs approval</Badge>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </Table>
              <Pager page={page} total={d.total} pageSize={PAGE} onPage={setPage} />
            </>
          )}
        </div>
      )}
    </Frame>
  );
}

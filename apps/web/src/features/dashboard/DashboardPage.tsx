import { AlertTriangle, Banknote, Receipt, TrendingUp } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "@/api";
import { errorMessage } from "@/api/client";
import type { SaleSummary } from "@/api/types";
import { useAuth } from "@/auth/AuthProvider";
import { Badge, Card, EmptyState, ErrorState, LoadingBlock, PageHeader, Stat } from "@/components/ui/Card";
import { formatDateTime, formatMoney, formatQty, startOfToday } from "@/lib/format";

const MAX_PAGES = 20;

async function loadToday(): Promise<{ sales: SaleSummary[]; truncated: boolean }> {
  const from = startOfToday().toISOString();
  const sales: SaleSummary[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await api.sales({ from, page, pageSize: 100 });
    sales.push(...r.items);
    if (sales.length >= r.total) return { sales, truncated: false };
  }
  return { sales, truncated: true };
}

export function DashboardPage() {
  const { user } = useAuth();
  const today = useQuery({ queryKey: ["dashboard", "today"], queryFn: loadToday, refetchInterval: 60_000 });
  const low = useQuery({ queryKey: ["dashboard", "low"], queryFn: api.lowStock, enabled: user?.role !== "CASHIER" });

  const completed = today.data?.sales.filter((s) => s.status === "COMPLETED") ?? [];
  const revenue = completed.reduce((s, x) => s + Number(x.grandTotal), 0);
  const items = completed.reduce((s, x) => s + x._count.items, 0);

  return (
    <div className="mx-auto max-w-6xl p-4 lg:p-8">
      <PageHeader title={`Hello, ${user?.fullName.split(" ")[0]}`} subtitle={user?.role === "CASHIER" ? "Your sales today" : "Store sales today"} />

      {today.isPending ? (
        <LoadingBlock />
      ) : today.isError ? (
        <ErrorState message={errorMessage(today.error)} onRetry={() => today.refetch()} />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" data-testid="dashboard-stats">
            <Stat label="Sales today" value={formatMoney(revenue)} icon={<Banknote className="size-5" />} />
            <Stat label="Transactions" value={completed.length} icon={<Receipt className="size-5" />} />
            <Stat label="Average sale" value={formatMoney(completed.length ? revenue / completed.length : 0)} icon={<TrendingUp className="size-5" />} />
            <Stat label="Items sold" value={items} hint="Line items on completed sales" />
          </div>
          {today.data.truncated && <p className="mt-2 text-xs text-amber-700">Showing the latest {MAX_PAGES * 100} sales only.</p>}

          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <Card className="p-5">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="font-semibold text-navy-950">Recent sales</h2>
                <Link to="/sales" className="text-sm font-medium text-navy-700 hover:underline">
                  View all
                </Link>
              </div>
              {completed.length === 0 ? (
                <EmptyState title="No sales yet today" />
              ) : (
                <ul className="divide-y divide-slate-100">
                  {completed.slice(0, 6).map((s) => (
                    <li key={s.id} className="flex items-center justify-between py-2.5 text-sm">
                      <div>
                        <p className="font-medium text-slate-900">{s.saleNumber}</p>
                        <p className="text-xs text-slate-500">
                          {formatDateTime(s.createdAt)} · {s.cashier.fullName}
                        </p>
                      </div>
                      <span className="num font-semibold">{formatMoney(s.grandTotal)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            {user?.role !== "CASHIER" && (
              <Card className="p-5">
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="flex items-center gap-2 font-semibold text-navy-950">
                    <AlertTriangle className="size-4 text-amber-500" /> Low stock
                  </h2>
                  <Link to="/inventory" className="text-sm font-medium text-navy-700 hover:underline">
                    Inventory
                  </Link>
                </div>
                {low.isPending ? (
                  <LoadingBlock />
                ) : low.isError ? (
                  <ErrorState message={errorMessage(low.error)} onRetry={() => low.refetch()} />
                ) : low.data.length === 0 ? (
                  <EmptyState title="All items are above their reorder level" />
                ) : (
                  <ul className="divide-y divide-slate-100" data-testid="low-stock">
                    {low.data.slice(0, 8).map((r) => (
                      <li key={r.variantId} className="flex items-center justify-between py-2.5 text-sm">
                        <div>
                          <p className="font-medium text-slate-900">{r.variantName ? `${r.productName} – ${r.variantName}` : r.productName}</p>
                          <p className="text-xs text-slate-500">
                            {r.sku} · reorder at {formatQty(r.reorderLevel)}
                          </p>
                        </div>
                        <Badge tone={Number(r.onHand) <= 0 ? "red" : "amber"}>{formatQty(r.onHand)} left</Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            )}
          </div>
        </>
      )}
    </div>
  );
}

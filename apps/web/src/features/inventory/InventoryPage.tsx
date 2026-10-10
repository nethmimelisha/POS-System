import { useState } from "react";
import { History, SlidersHorizontal } from "lucide-react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import { errorMessage } from "@/api/client";
import { Alert, Badge, Card, EmptyState, ErrorState, LoadingBlock, PageHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { formatDateTime, formatQty } from "@/lib/format";

interface Row {
  variantId: string;
  label: string;
  sku: string;
  onHand: number;
  reorder: number;
}

export function InventoryPage() {
  const [tab, setTab] = useState<"all" | "low">("all");
  const [search, setSearch] = useState("");
  const [adjust, setAdjust] = useState<Row | null>(null);
  const [history, setHistory] = useState<Row | null>(null);

  const all = useQuery({
    queryKey: ["inventory", "all", search],
    queryFn: async (): Promise<Row[]> => {
      const r = await api.products({ search: search.trim() || undefined, pageSize: 100, active: true });
      return r.items.filter((p) => p.trackStock).flatMap((p) => p.variants.filter((v) => v.isActive).map((v) => ({ variantId: v.id, label: v.name ? `${p.name} – ${v.name}` : p.name, sku: v.sku, onHand: Number(v.stockLevel?.onHand ?? 0), reorder: Number(v.reorderLevel) })));
    },
    enabled: tab === "all",
    placeholderData: keepPreviousData,
  });
  const low = useQuery({
    queryKey: ["inventory", "low"],
    queryFn: async (): Promise<Row[]> => (await api.lowStock()).map((r) => ({ variantId: r.variantId, label: r.variantName ? `${r.productName} – ${r.variantName}` : r.productName, sku: r.sku, onHand: Number(r.onHand), reorder: Number(r.reorderLevel) })),
    enabled: tab === "low",
  });
  const q = tab === "all" ? all : low;

  return (
    <div className="mx-auto max-w-6xl p-4 lg:p-8">
      <PageHeader title="Inventory" subtitle="Stock on hand, low-stock alerts and adjustments" />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg bg-slate-100 p-1" role="tablist">
          {(["all", "low"] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`h-9 rounded-md px-4 text-sm font-medium ${tab === t ? "bg-white text-navy-900 shadow-sm" : "text-slate-500"}`}>
              {t === "all" ? "All stock" : "Low stock"}
            </button>
          ))}
        </div>
        {tab === "all" && <Input aria-label="Search stock" placeholder="Search name, SKU or barcode" wrapperClassName="w-72" value={search} onChange={(e) => setSearch(e.target.value)} />}
      </div>
      <Card className="overflow-hidden">
        {q.isPending ? (
          <LoadingBlock />
        ) : q.isError ? (
          <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />
        ) : q.data.length === 0 ? (
          <EmptyState title={tab === "low" ? "Nothing is low on stock" : "No stock items found"} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm" data-testid="inventory-table">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Item</th>
                  <th className="px-4 py-3">SKU</th>
                  <th className="px-4 py-3 text-right">On hand</th>
                  <th className="px-4 py-3 text-right">Reorder at</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {q.data.map((r) => (
                  <tr key={r.variantId}>
                    <td className="px-4 py-3 font-medium text-slate-900">{r.label}</td>
                    <td className="px-4 py-3 text-slate-600">{r.sku}</td>
                    <td className="num px-4 py-3 text-right">
                      <Badge tone={r.onHand <= 0 ? "red" : r.onHand <= r.reorder ? "amber" : "green"}>{formatQty(r.onHand)}</Badge>
                    </td>
                    <td className="num px-4 py-3 text-right text-slate-600">{formatQty(r.reorder)}</td>
                    <td className="space-x-1 px-4 py-3 text-right">
                      <Button variant="ghost" size="sm" aria-label={`History for ${r.label}`} icon={<History className="size-4" />} onClick={() => setHistory(r)}>
                        History
                      </Button>
                      <Button variant="secondary" size="sm" aria-label={`Adjust ${r.label}`} icon={<SlidersHorizontal className="size-4" />} onClick={() => setAdjust(r)}>
                        Adjust
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {adjust && <AdjustModal row={adjust} onClose={() => setAdjust(null)} />}
      {history && <HistoryModal row={history} onClose={() => setHistory(null)} />}
    </div>
  );
}

function AdjustModal({ row, onClose }: { row: Row; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [type, setType] = useState<"PURCHASE" | "ADJUSTMENT" | "DAMAGE">("PURCHASE");
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const n = Number(qty);
  const valid = qty !== "" && Number.isFinite(n) && n !== 0 && (type === "ADJUSTMENT" || n > 0) && reason.trim().length > 0;

  const save = useMutation({
    mutationFn: () => api.adjustStock({ variantId: row.variantId, type, quantity: n, reason: reason.trim() }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["inventory"] });
      void qc.invalidateQueries({ queryKey: ["products"] });
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
      toast.success(`${row.label}: now ${formatQty(r.onHand)} on hand`);
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  return (
    <Modal
      open
      size="sm"
      title={`Adjust stock`}
      onClose={onClose}
      locked={save.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button loading={save.isPending} disabled={!valid} onClick={() => (setError(null), save.mutate())}>
            Save adjustment
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-slate-600">
          <span className="font-medium text-slate-900">{row.label}</span> · {formatQty(row.onHand)} on hand
        </p>
        {error && <Alert>{error}</Alert>}
        <Select label="Type" value={type} onChange={(e) => setType(e.target.value as typeof type)}>
          <option value="PURCHASE">Stock received (adds)</option>
          <option value="DAMAGE">Damaged / lost (removes)</option>
          <option value="ADJUSTMENT">Stock count correction (+/−)</option>
        </Select>
        <Input label="Quantity" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} hint={type === "ADJUSTMENT" ? "Use a negative number to remove stock" : undefined} autoFocus />
        <Input label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
    </Modal>
  );
}

function HistoryModal({ row, onClose }: { row: Row; onClose: () => void }) {
  const q = useQuery({ queryKey: ["inventory", "movements", row.variantId], queryFn: () => api.movements(row.variantId) });
  return (
    <Modal open size="md" title={`Stock history – ${row.label}`} onClose={onClose}>
      {q.isPending ? (
        <LoadingBlock />
      ) : q.isError ? (
        <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />
      ) : q.data.length === 0 ? (
        <EmptyState title="No movements yet" />
      ) : (
        <ul className="divide-y divide-slate-100 text-sm">
          {q.data.map((m) => (
            <li key={m.id} className="flex items-center justify-between py-2.5">
              <div>
                <p className="font-medium text-slate-900">{m.type.toLowerCase()}</p>
                <p className="text-xs text-slate-500">
                  {formatDateTime(m.createdAt)}
                  {m.reason ? ` · ${m.reason}` : ""}
                </p>
              </div>
              <span className={`num font-semibold ${Number(m.quantity) < 0 ? "text-red-600" : "text-emerald-700"}`}>{Number(m.quantity) > 0 ? "+" : ""}{formatQty(m.quantity)}</span>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, Printer, Search, Undo2 } from "lucide-react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import { ApiError, NetworkError, errorMessage } from "@/api/client";
import type { RefundReceipt, Returnable, ReturnReason, SaleReturn } from "@/api/types";
import { Alert, Badge, Card, EmptyState, ErrorState, LoadingBlock, PageHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Select, Textarea } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Pager } from "@/components/ui/Pager";
import { useToast } from "@/components/ui/Toast";
import { formatDateTime, formatMoney, formatQty, toCents } from "@/lib/format";
import { printReceipt } from "@/hardware";

const REASONS: { value: ReturnReason; label: string }[] = [
  { value: "DEFECTIVE", label: "Defective" },
  { value: "DAMAGED", label: "Damaged" },
  { value: "WRONG_ITEM", label: "Wrong item" },
  { value: "CHANGED_MIND", label: "Customer changed mind" },
  { value: "OVERCHARGED", label: "Overcharged" },
  { value: "OTHER", label: "Other" },
];
const METHODS = [
  { value: "cash", label: "Cash" },
  { value: "card", label: "Card" },
  { value: "online", label: "Online" },
];
const STATUS_TONE = { COMPLETED: "green", PENDING: "amber", FAILED: "red" } as const;

type Tab = "new" | "history";

export function ReturnsPage() {
  const [tab, setTab] = useState<Tab>("new");
  return (
    <div className="mx-auto max-w-6xl p-4 lg:p-8">
      <PageHeader title="Returns & refunds" subtitle="Return items against an original invoice. Managers and admins only." />
      <div className="mb-5 inline-flex rounded-lg bg-slate-100 p-1" role="tablist">
        {(["new", "history"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`h-9 rounded-md px-4 text-sm font-medium ${tab === t ? "bg-white text-navy-900 shadow-sm" : "text-slate-500"}`}>
            {t === "new" ? "New return" : "Return history"}
          </button>
        ))}
      </div>
      {tab === "new" ? <NewReturn onDone={() => setTab("history")} /> : <History />}
    </div>
  );
}

function NewReturn({ onDone }: { onDone: () => void }) {
  const [term, setTerm] = useState("");
  const [saleId, setSaleId] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);

  async function find() {
    const s = term.trim();
    if (!s) return;
    setLooking(true);
    setSearchError(null);
    setSaleId(null);
    try {
      const res = await api.sales({ search: s, pageSize: 5, status: "COMPLETED" });
      const hit = res.items.find((x) => x.saleNumber.toLowerCase() === s.toLowerCase()) ?? res.items[0];
      if (!hit) setSearchError(`No completed invoice matches “${s}”.`);
      else setSaleId(hit.id);
    } catch (e) {
      setSearchError(errorMessage(e));
    } finally {
      setLooking(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card className="p-5">
        <form
          className="flex max-w-xl items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void find();
          }}
        >
          <Input wrapperClassName="flex-1" label="Original invoice number" placeholder="e.g. INV-000123" leading={<Search className="size-4" />} value={term} onChange={(e) => setTerm(e.target.value)} autoFocus />
          <Button type="submit" loading={looking} disabled={!term.trim()}>
            Find invoice
          </Button>
        </form>
        {searchError && (
          <div className="mt-3 max-w-xl">
            <Alert tone="amber">{searchError}</Alert>
          </div>
        )}
      </Card>
      {saleId && <ReturnForm key={saleId} saleId={saleId} onDone={onDone} />}
    </div>
  );
}

function ReturnForm({ saleId, onDone }: { saleId: string; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["returnable", saleId], queryFn: () => api.returnable(saleId) });
  const registers = useQuery({ queryKey: ["registers"], queryFn: api.registers, staleTime: Infinity });
  const [qty, setQty] = useState<Record<string, string>>({});
  const [resellable, setResellable] = useState<Record<string, boolean>>({});
  const [reason, setReason] = useState<ReturnReason>("DEFECTIVE");
  const [notes, setNotes] = useState("");
  const [registerId, setRegisterId] = useState(() => localStorage.getItem("pos.register") ?? "");
  const [refunds, setRefunds] = useState<{ method: string; amount: string | null; reference: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<SaleReturn | null>(null);
  // One id per form: a retry after a dropped connection can never refund twice.
  const returnId = useRef(crypto.randomUUID());
  const inFlight = useRef(false);

  const selected = (q.data?.items ?? [])
    .map((i) => ({ i, n: Number(qty[i.saleItemId] || 0) }))
    .filter((x) => x.n > 0);
  const lineKey = JSON.stringify(selected.map((x) => [x.i.saleItemId, x.n]));
  const quote = useQuery({
    queryKey: ["return-quote", saleId, lineKey],
    queryFn: () => api.returnQuote(saleId, selected.map((x) => ({ saleItemId: x.i.saleItemId, quantity: x.n }))),
    enabled: selected.length > 0 && selected.every((x) => x.n <= Number(x.i.remainingQuantity)),
    placeholderData: keepPreviousData,
  });

  const data: Returnable | undefined = q.data;
  const total = quote.data && selected.length > 0 ? quote.data.refundTotal : "0.00";
  const totalCents = toCents(total);
  const reg = registerId || String(registers.data?.[0]?.id ?? "");
  const rows = refunds ?? [{ method: data?.paidByMethod[0]?.method ?? "cash", amount: null, reference: "" }];
  const autoAmount = String(totalCents / 100);
  const amountOf = (r: (typeof rows)[number]) => r.amount ?? autoAmount;
  const rowsCents = rows.reduce((s, r) => s + toCents(amountOf(r) || 0), 0);
  const resetAmounts = () => setRefunds((cur) => (cur && cur.length === 1 ? cur.map((x) => ({ ...x, amount: null })) : cur));
  const problems: string[] = [];
  if (selected.some((x) => x.n > Number(x.i.remainingQuantity))) problems.push("A quantity exceeds what can still be returned.");
  if (selected.length === 0) problems.push("Choose at least one item to return.");
  if (selected.length > 0 && rowsCents !== totalCents) problems.push(`Refund amounts must add up to ${formatMoney(total)}.`);
  if (rows.some((r) => r.method !== "cash" && !r.reference.trim())) problems.push("Card and online refunds need a reference.");
  const valid = problems.length === 0 && !!quote.data && !quote.isFetching && !!reg;

  const setRows = (next: typeof rows) => setRefunds(next);

  const submit = useMutation({
    mutationFn: () =>
      api.createReturn({
        id: returnId.current,
        saleId,
        registerId: Number(reg),
        reason,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        items: selected.map((x) => ({ saleItemId: x.i.saleItemId, quantity: x.n, resellable: !!resellable[x.i.saleItemId] })),
        refunds: rows.map((r) => ({ method: r.method, amount: Number(amountOf(r)), ...(r.method !== "cash" ? { reference: r.reference.trim() } : {}) })),
      }),
    onSuccess: (ret) => {
      inFlight.current = false;
      localStorage.setItem("pos.register", reg);
      void qc.invalidateQueries({ queryKey: ["returns"] });
      void qc.invalidateQueries({ queryKey: ["returnable"] });
      void qc.invalidateQueries({ queryKey: ["shift"] });
      void qc.invalidateQueries({ queryKey: ["products"] });
      toast.success(`Return ${ret.returnNumber} recorded`);
      setReceipt(ret);
    },
    onError: (e) => {
      inFlight.current = false;
      if (e instanceof NetworkError) setError("Connection lost. The return may have been recorded. Press Process again (it is safe) or check Return history.");
      else if (e instanceof ApiError && e.status === 403) setError("Only managers and admins can process refunds.");
      else setError(errorMessage(e));
    },
  });

  const go = () => {
    if (inFlight.current || !valid) return;
    inFlight.current = true;
    setError(null);
    submit.mutate();
  };

  if (q.isPending) return <LoadingBlock />;
  if (q.isError || !data) return <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />;

  return (
    <>
      <Card className="overflow-hidden" data-testid="return-form">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 p-4">
          <div>
            <h2 className="font-semibold text-navy-950">
              {data.sale.saleNumber} · {formatMoney(data.sale.grandTotal)}
            </h2>
            <p className="text-sm text-slate-500">
              {formatDateTime(data.sale.createdAt)} · {data.sale.cashier}
              {data.sale.customer && ` · ${data.sale.customer.name}`}
            </p>
          </div>
          <div className="flex gap-1.5">
            {data.paidByMethod.map((p, i) => (
              <Badge key={i} tone="navy">
                {p.name} {formatMoney(p.amount)}
              </Badge>
            ))}
          </div>
        </div>
        {data.fullyReturned ? (
          <EmptyState title="Fully returned" hint="Every item on this invoice has already been returned." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Item</th>
                  <th className="px-4 py-3 text-right">Sold</th>
                  <th className="px-4 py-3 text-right">Returned</th>
                  <th className="px-4 py-3 text-right">Return qty</th>
                  <th className="px-4 py-3">Resellable</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.items.map((i) => {
                  const remaining = Number(i.remainingQuantity);
                  const n = Number(qty[i.saleItemId] || 0);
                  return (
                    <tr key={i.saleItemId} data-testid="return-line">
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-900">{i.description}</div>
                        <div className="text-xs text-slate-500">
                          {i.sku} · {formatMoney(i.unitPrice)}
                        </div>
                      </td>
                      <td className="num px-4 py-3 text-right">{formatQty(i.soldQuantity)}</td>
                      <td className="num px-4 py-3 text-right">{formatQty(i.returnedQuantity)}</td>
                      <td className="px-4 py-3 text-right">
                        {remaining > 0 ? (
                          <div className="inline-flex items-center gap-2">
                            <input
                              aria-label={`Return quantity for ${i.description}`}
                              inputMode="decimal"
                              className={`num h-9 w-20 rounded-lg border px-2 text-right text-sm ${n > remaining ? "border-red-400" : "border-slate-300"}`}
                              value={qty[i.saleItemId] ?? ""}
                              placeholder="0"
                              onChange={(e) => (resetAmounts(), setQty({ ...qty, [i.saleItemId]: e.target.value }))}
                            />
                            <button type="button" className="text-xs font-medium text-navy-700 underline" onClick={() => (resetAmounts(), setQty({ ...qty, [i.saleItemId]: String(remaining) }))}>
                              All ({formatQty(remaining)})
                            </button>
                          </div>
                        ) : (
                          <Badge>Returned</Badge>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {remaining > 0 && (
                          <label className="flex items-center gap-2 text-slate-600">
                            <input type="checkbox" className="size-4 accent-navy-900" aria-label={`Resellable ${i.description}`} checked={!!resellable[i.saleItemId]} onChange={(e) => setResellable({ ...resellable, [i.saleItemId]: e.target.checked })} />
                            Back to stock
                          </label>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {!data.fullyReturned && (
          <div className="grid gap-4 border-t border-slate-200 p-4 md:grid-cols-2">
            <div className="space-y-3">
              <Select label="Reason" value={reason} onChange={(e) => setReason(e.target.value as ReturnReason)}>
                {REASONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </Select>
              <Select label="Register" value={reg} onChange={(e) => setRegisterId(e.target.value)}>
                {registers.data?.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </Select>
              <Textarea label="Notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
            <div className="space-y-3">
              <div className="flex items-baseline justify-between rounded-lg bg-navy-50 px-4 py-3">
                <span className="text-sm font-medium text-navy-900">Refund total</span>
                <span className="num text-2xl font-semibold text-navy-950" data-testid="refund-total">
                  {formatMoney(total)}
                </span>
              </div>
              <div className="space-y-2">
                {rows.map((r, idx) => (
                  <div key={idx} className="grid grid-cols-[7rem_1fr] items-end gap-2">
                    <Select aria-label="Refund method" value={r.method} onChange={(e) => setRows(rows.map((x, k) => (k === idx ? { ...x, method: e.target.value } : x)))}>
                      {METHODS.map((m) => (
                        <option key={m.value} value={m.value}>
                          {m.label}
                        </option>
                      ))}
                    </Select>
                    <Input aria-label="Refund amount" inputMode="decimal" value={amountOf(r)} onChange={(e) => setRows(rows.map((x, k) => (k === idx ? { ...x, amount: e.target.value } : x)))} />
                    {r.method !== "cash" && (
                      <Input wrapperClassName="col-span-2" aria-label="Refund reference" placeholder="Reference (e.g. terminal or transfer ID)" value={r.reference} onChange={(e) => setRows(rows.map((x, k) => (k === idx ? { ...x, reference: e.target.value } : x)))} />
                    )}
                  </div>
                ))}
                <div className="flex gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setRows([...rows.map((r) => ({ ...r, amount: amountOf(r) })), { method: "cash", amount: "0", reference: "" }])}>
                    Split refund
                  </Button>
                  {rows.length > 1 && (
                    <Button variant="ghost" size="sm" onClick={() => setRows(rows.slice(0, -1))}>
                      Remove last
                    </Button>
                  )}
                </div>
              </div>
              {rows.some((r) => r.method !== "cash") && <Alert tone="amber">Card and online refunds stay pending until the payment provider confirms them. Confirm them in Return history.</Alert>}
              {selected.length > 0 && problems.length > 0 && <Alert tone="amber">{problems[0]}</Alert>}
              {error && <Alert>{error}</Alert>}
              <Button size="lg" className="w-full" icon={<Undo2 className="size-5" />} loading={submit.isPending} disabled={!valid} onClick={go}>
                Process refund
              </Button>
            </div>
          </div>
        )}
      </Card>
      {receipt && (
        <RefundReceiptModal
          returnId={receipt.id}
          onClose={() => {
            setReceipt(null);
            onDone();
          }}
        />
      )}
    </>
  );
}

function History() {
  const [page, setPage] = useState(1);
  const [pending, setPending] = useState(false);
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["returns", page, pending], queryFn: () => api.returns({ page, pageSize: 15, pendingRefunds: pending || undefined }), placeholderData: keepPreviousData });
  const [resolve, setResolve] = useState<{ ret: SaleReturn; refundId: number; mode: "confirm" | "fail" } | null>(null);

  return (
    <>
      <div className="mb-3 flex justify-end">
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" className="size-4 accent-navy-900" checked={pending} onChange={(e) => (setPending(e.target.checked), setPage(1))} />
          Pending provider confirmation only
        </label>
      </div>
      <Card className="overflow-hidden">
        {q.isPending ? (
          <LoadingBlock />
        ) : q.isError ? (
          <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />
        ) : q.data.items.length === 0 ? (
          <EmptyState title="No returns yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm" data-testid="returns-table">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Return</th>
                  <th className="px-4 py-3">Invoice</th>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Reason</th>
                  <th className="px-4 py-3 text-right">Refund</th>
                  <th className="px-4 py-3">Refund status</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {q.data.items.map((r) => (
                  <tr key={r.id} className="align-top">
                    <td className="px-4 py-3 font-medium">{r.returnNumber}</td>
                    <td className="px-4 py-3 text-slate-600">{r.sale.saleNumber}</td>
                    <td className="px-4 py-3 text-slate-600">{formatDateTime(r.createdAt)}</td>
                    <td className="px-4 py-3 text-slate-600">{REASONS.find((x) => x.value === r.reason)?.label}</td>
                    <td className="num px-4 py-3 text-right font-semibold">{formatMoney(r.refundTotal)}</td>
                    <td className="space-y-1.5 px-4 py-3">
                      {r.refunds.map((f) => (
                        <div key={f.id} className="flex flex-wrap items-center gap-2">
                          <Badge tone={STATUS_TONE[f.status]}>{f.status.toLowerCase()}</Badge>
                          <span className="text-slate-600">
                            {f.method.name} {formatMoney(f.amount)}
                          </span>
                          {f.status === "PENDING" && (
                            <>
                              <Button size="sm" variant="secondary" onClick={() => setResolve({ ret: r, refundId: f.id, mode: "confirm" })}>
                                Confirm
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => setResolve({ ret: r, refundId: f.id, mode: "fail" })}>
                                Mark failed
                              </Button>
                            </>
                          )}
                        </div>
                      ))}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button variant="ghost" size="sm" icon={<Printer className="size-4" />} onClick={() => setReceiptId(r.id)}>
                        Receipt
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager page={page} total={q.data?.total ?? 0} pageSize={15} onPage={setPage} />
      </Card>
      {receiptId && <RefundReceiptModal returnId={receiptId} onClose={() => setReceiptId(null)} />}
      {resolve && <ResolveModal {...resolve} onClose={() => setResolve(null)} />}
    </>
  );
}

function ResolveModal({ ret, refundId, mode, onClose }: { ret: SaleReturn; refundId: number; mode: "confirm" | "fail"; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => (mode === "confirm" ? api.confirmRefund(ret.id, refundId, text.trim()) : api.failRefund(ret.id, refundId, text.trim())),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["returns"] });
      void qc.invalidateQueries({ queryKey: ["receipt-refund", ret.id] });
      toast.success(mode === "confirm" ? "Refund confirmed" : "Refund marked as failed");
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const valid = text.trim().length >= 3;
  return (
    <Modal
      open
      size="sm"
      title={mode === "confirm" ? "Confirm refund" : "Mark refund as failed"}
      onClose={onClose}
      locked={m.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={m.isPending}>
            Cancel
          </Button>
          <Button variant={mode === "confirm" ? "success" : "danger"} loading={m.isPending} disabled={!valid} onClick={() => (setError(null), m.mutate())}>
            {mode === "confirm" ? "Confirm refund" : "Mark failed"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error && <Alert>{error}</Alert>}
        <p className="text-sm text-slate-600">
          {mode === "confirm"
            ? `Only confirm after the payment provider has confirmed the refund for ${ret.returnNumber}.`
            : "The customer has not received this refund. The amount stays unpaid until you re-issue it."}
        </p>
        <Input label={mode === "confirm" ? "Provider reference" : "Reason"} autoFocus value={text} onChange={(e) => setText(e.target.value)} />
      </div>
    </Modal>
  );
}

export function RefundReceiptView({ r }: { r: RefundReceipt }) {
  return (
    <div className="receipt" data-testid="refund-receipt">
      <h1>{r.business.name}</h1>
      <div className="center muted">
        {r.business.address && <div>{r.business.address}</div>}
        {r.business.phone && <div>Tel: {r.business.phone}</div>}
        {r.business.vatNumber && <div>VAT No: {r.business.vatNumber}</div>}
      </div>
      <div className="center strong" style={{ marginTop: 4 }}>
        REFUND RECEIPT
      </div>
      <hr className="rule" />
      <div className="row">
        <span>Refund no.</span>
        <span className="strong">{r.refundNumber}</span>
      </div>
      <div className="row">
        <span>Original invoice</span>
        <span>{r.originalInvoice}</span>
      </div>
      <div className="row">
        <span>Date</span>
        <span>{formatDateTime(r.issuedAt)}</span>
      </div>
      <div className="row">
        <span>Processed by</span>
        <span>{r.processedBy}</span>
      </div>
      {r.customer && (
        <div className="row">
          <span>Customer</span>
          <span>{r.customer.name}</span>
        </div>
      )}
      <div className="row">
        <span>Reason</span>
        <span>{REASONS.find((x) => x.value === r.reason)?.label ?? r.reason}</span>
      </div>
      <hr className="rule" />
      {r.items.map((it, i) => (
        <div key={i} style={{ marginBottom: 3 }}>
          <div>{it.description}</div>
          <div className="row muted">
            <span>{formatQty(it.quantity)} returned</span>
            <span>{it.refundAmount}</span>
          </div>
        </div>
      ))}
      <hr className="rule" />
      {r.totals.tax && (
        <div className="row">
          <span>VAT refunded</span>
          <span>{r.totals.tax}</span>
        </div>
      )}
      <div className="row big">
        <span>REFUND</span>
        <span>{r.totals.refundTotal}</span>
      </div>
      <hr className="rule" />
      {r.refunds.map((f, i) => (
        <div key={i} style={{ marginBottom: 3 }}>
          <div className="row">
            <span>
              {f.method}
              {f.reference ? ` (${f.reference})` : ""}
            </span>
            <span>{f.amount}</span>
          </div>
          <div className="muted">{f.statusNote}</div>
        </div>
      ))}
      <hr className="rule" />
      <div className="center muted">Thank you</div>
    </div>
  );
}

function RefundReceiptModal({ returnId, onClose }: { returnId: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ["receipt-refund", returnId], queryFn: () => api.returnReceipt(returnId) });
  const printRoot = document.getElementById("print-root");
  const pending = q.data?.refunds.some((f) => f.status === "PENDING");
  return (
    <Modal
      open
      size="sm"
      title="Refund receipt"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button icon={<Printer className="size-4" />} disabled={!q.data} onClick={() => void printReceipt()}>
            Print receipt
          </Button>
        </>
      }
    >
      {q.isPending && <LoadingBlock label="Loading receipt…" />}
      {q.isError && <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />}
      {q.data && (
        <>
          <div className="mb-3">
            {pending ? <Alert tone="amber">Card/online refund pending provider confirmation.</Alert> : <Alert tone="green"><CheckCircle2 className="mr-1 inline size-4" />Refund recorded.</Alert>}
          </div>
          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white py-2 shadow-inner">
            <RefundReceiptView r={q.data} />
          </div>
          {printRoot && createPortal(<RefundReceiptView r={q.data} />, printRoot)}
        </>
      )}
    </Modal>
  );
}

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeftRight, Minus, Plus, Printer, X } from "lucide-react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import { ApiError, NetworkError, errorMessage } from "@/api/client";
import type { Exchange, ExchangeReceipt, ReturnReason } from "@/api/types";
import { Alert, Badge, Card, EmptyState, ErrorState, LoadingBlock, PageHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { printReceipt } from "@/hardware";
import { formatDateTime, formatMoney, formatQty, toCents } from "@/lib/format";

const REASONS: { value: ReturnReason; label: string }[] = [
  { value: "CHANGED_MIND", label: "Customer changed mind" },
  { value: "WRONG_ITEM", label: "Wrong item" },
  { value: "DEFECTIVE", label: "Defective" },
  { value: "DAMAGED", label: "Damaged" },
  { value: "OVERCHARGED", label: "Overcharged" },
  { value: "OTHER", label: "Other" },
];
const METHODS = [
  { value: "cash", label: "Cash" },
  { value: "card", label: "Card" },
  { value: "online", label: "Online" },
];

type Tab = "new" | "history";

export function ExchangesPage() {
  const [tab, setTab] = useState<Tab>("new");
  return (
    <div className="mx-auto max-w-6xl p-4 lg:p-8">
      <PageHeader title="Exchanges" subtitle="Swap items from an original invoice for others in one step. Managers and admins only." />
      <div className="mb-5 inline-flex rounded-lg bg-slate-100 p-1" role="tablist">
        {(["new", "history"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`h-9 rounded-md px-4 text-sm font-medium ${tab === t ? "bg-white text-navy-900 shadow-sm" : "text-slate-500"}`}>
            {t === "new" ? "New exchange" : "Exchange history"}
          </button>
        ))}
      </div>
      {tab === "new" ? <NewExchange onDone={() => setTab("history")} /> : <History />}
    </div>
  );
}

function NewExchange({ onDone }: { onDone: () => void }) {
  const [term, setTerm] = useState("");
  const [saleId, setSaleId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);

  async function find() {
    const s = term.trim();
    if (!s) return;
    setLooking(true);
    setMessage(null);
    setSaleId(null);
    try {
      const res = await api.sales({ search: s, pageSize: 5, status: "COMPLETED" });
      const hit = res.items.find((x) => x.saleNumber.toLowerCase() === s.toLowerCase()) ?? res.items[0];
      if (hit) setSaleId(hit.id);
      else setMessage(`No completed invoice matches “${s}”.`);
    } catch (e) {
      setMessage(errorMessage(e));
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
          <Input wrapperClassName="flex-1" label="Original invoice number" placeholder="e.g. INV-000123" value={term} onChange={(e) => setTerm(e.target.value)} autoFocus />
          <Button type="submit" loading={looking} disabled={!term.trim()}>
            Find invoice
          </Button>
        </form>
        {message && (
          <div className="mt-3 max-w-xl">
            <Alert tone="amber">{message}</Alert>
          </div>
        )}
      </Card>
      {saleId && <ExchangeForm key={saleId} saleId={saleId} onDone={onDone} />}
    </div>
  );
}

interface Pick {
  variantId: string;
  description: string;
  sku: string;
  price: string;
  quantity: number;
}

function ExchangeForm({ saleId, onDone }: { saleId: string; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["returnable", saleId], queryFn: () => api.returnable(saleId) });
  const registers = useQuery({ queryKey: ["registers"], queryFn: api.registers, staleTime: Infinity });
  const [qty, setQty] = useState<Record<string, string>>({});
  const [resellable, setResellable] = useState<Record<string, boolean>>({});
  const [picks, setPicks] = useState<Pick[]>([]);
  const [search, setSearch] = useState("");
  const [reason, setReason] = useState<ReturnReason>("CHANGED_MIND");
  const [method, setMethod] = useState("cash");
  const [reference, setReference] = useState("");
  const [tendered, setTendered] = useState("");
  const [registerId, setRegisterId] = useState(() => localStorage.getItem("pos.register") ?? "");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Exchange | null>(null);
  // One id per form: a retry after a dropped connection replays the same exchange instead of creating another.
  const exchangeId = useRef(crypto.randomUUID());
  const inFlight = useRef(false);

  const selected = (q.data?.items ?? []).map((i) => ({ i, n: Number(qty[i.saleItemId] || 0) })).filter((x) => x.n > 0);
  const overReturn = selected.some((x) => x.n > Number(x.i.remainingQuantity));
  const retLines = selected.map((x) => ({ saleItemId: x.i.saleItemId, quantity: x.n }));
  const newLines = picks.map((p) => ({ variantId: p.variantId, quantity: p.quantity }));
  const key = JSON.stringify([retLines, newLines]);
  const quote = useQuery({
    queryKey: ["exchange-quote", saleId, key],
    queryFn: () => api.exchangeQuote(saleId, retLines, newLines),
    enabled: selected.length > 0 && picks.length > 0 && !overReturn,
    placeholderData: keepPreviousData,
    retry: false,
  });

  const found = useQuery({
    queryKey: ["exchange-search", search.trim()],
    queryFn: () => api.products({ search: search.trim(), pageSize: 8, active: true }),
    enabled: search.trim().length >= 2,
    placeholderData: keepPreviousData,
  });

  const reg = registerId || String(registers.data?.[0]?.id ?? "");
  const diffCents = quote.data ? toCents(quote.data.difference) : 0;
  const owes = diffCents > 0;
  const refunds = diffCents < 0;
  const tenderedCents = tendered === "" ? diffCents : toCents(tendered);
  const problems: string[] = [];
  if (selected.length === 0) problems.push("Choose at least one item to return.");
  if (overReturn) problems.push("A return quantity exceeds what can still be returned.");
  if (picks.length === 0) problems.push("Add at least one replacement item.");
  if (owes && method === "cash" && tenderedCents < diffCents) problems.push("Cash received is less than the amount due.");
  if ((owes || refunds) && method !== "cash" && !reference.trim()) problems.push("Card and online payments need a reference.");
  const valid = problems.length === 0 && !!quote.data && !quote.isFetching && !!reg;

  const submit = useMutation({
    mutationFn: () => {
      const amount = Math.abs(diffCents) / 100;
      const ref = method !== "cash" ? { reference: reference.trim() } : {};
      return api.createExchange({
        id: exchangeId.current,
        saleId,
        registerId: Number(reg),
        reason,
        returnItems: selected.map((x) => ({ saleItemId: x.i.saleItemId, quantity: x.n, resellable: !!resellable[x.i.saleItemId] })),
        newItems: newLines,
        payments: owes ? [{ method, amount: method === "cash" ? Math.min(tenderedCents, diffCents) / 100 : amount, ...ref }] : [],
        refunds: refunds ? [{ method, amount, ...ref }] : [],
      });
    },
    onSuccess: (x) => {
      inFlight.current = false;
      localStorage.setItem("pos.register", reg);
      for (const k of ["returns", "returnable", "sales", "shift", "products", "exchanges"]) void qc.invalidateQueries({ queryKey: [k] });
      toast.success(`Exchange ${x.exchangeNumber} recorded`);
      setDone(x);
    },
    onError: (e) => {
      inFlight.current = false;
      if (e instanceof NetworkError) setError("Connection lost. The exchange may have been recorded. Press Complete again (it is safe) or check Exchange history.");
      else if (e instanceof ApiError && e.status === 403) setError("Only managers and admins can process exchanges.");
      else setError(errorMessage(e));
    },
  });

  const go = () => {
    if (inFlight.current || !valid) return;
    inFlight.current = true;
    setError(null);
    submit.mutate();
  };

  const addPick = (v: { id: string; sku: string; name: string | null; sellPrice: string }, productName: string) =>
    setPicks((cur) => {
      const hit = cur.find((x) => x.variantId === v.id);
      if (hit) return cur.map((x) => (x.variantId === v.id ? { ...x, quantity: x.quantity + 1 } : x));
      return [...cur, { variantId: v.id, description: v.name ? `${productName} – ${v.name}` : productName, sku: v.sku, price: v.sellPrice, quantity: 1 }];
    });

  if (q.isPending) return <LoadingBlock />;
  if (q.isError || !q.data) return <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />;
  const data = q.data;

  return (
    <>
      <div data-testid="exchange-form"><Card className="overflow-hidden">
        <div className="border-b border-slate-200 p-4">
          <h2 className="font-semibold text-navy-950">
            {data.sale.saleNumber} · {formatMoney(data.sale.grandTotal)}
          </h2>
          <p className="text-sm text-slate-500">
            {formatDateTime(data.sale.createdAt)} · {data.sale.cashier}
          </p>
        </div>

        <div className="grid gap-0 lg:grid-cols-2 lg:divide-x lg:divide-slate-200">
          <section className="p-4">
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">1 · Items coming back</h3>
            {data.fullyReturned ? (
              <EmptyState title="Fully returned" hint="Nothing on this invoice can be exchanged." />
            ) : (
              <ul className="space-y-3">
                {data.items.map((i) => {
                  const remaining = Number(i.remainingQuantity);
                  return (
                    <li key={i.saleItemId} className="flex flex-wrap items-center justify-between gap-2" data-testid="exchange-return-line">
                      <div>
                        <div className="text-sm font-medium text-slate-900">{i.description}</div>
                        <div className="text-xs text-slate-500">
                          {i.sku} · {formatMoney(i.unitPrice)} · can return {formatQty(remaining)}
                        </div>
                      </div>
                      {remaining > 0 && (
                        <div className="flex items-center gap-3">
                          <label className="flex items-center gap-1.5 text-xs text-slate-600">
                            <input type="checkbox" className="size-4 accent-navy-900" aria-label={`Resellable ${i.description}`} checked={!!resellable[i.saleItemId]} onChange={(e) => setResellable({ ...resellable, [i.saleItemId]: e.target.checked })} />
                            Back to stock
                          </label>
                          <input
                            aria-label={`Return quantity for ${i.description}`}
                            inputMode="decimal"
                            placeholder="0"
                            className={`num h-9 w-20 rounded-lg border px-2 text-right text-sm ${Number(qty[i.saleItemId] || 0) > remaining ? "border-red-400" : "border-slate-300"}`}
                            value={qty[i.saleItemId] ?? ""}
                            onChange={(e) => setQty({ ...qty, [i.saleItemId]: e.target.value })}
                          />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="p-4">
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">2 · Replacement items</h3>
            <Input aria-label="Search replacement" placeholder="Search name, SKU or barcode" value={search} onChange={(e) => setSearch(e.target.value)} />
            {found.data && search.trim().length >= 2 && (
              <ul className="mt-2 max-h-44 divide-y divide-slate-100 overflow-auto rounded-lg border border-slate-200" data-testid="exchange-results">
                {found.data.items.flatMap((p) =>
                  p.variants
                    .filter((v) => v.isActive)
                    .map((v) => (
                      <li key={v.id}>
                        <button type="button" className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-slate-50" onClick={() => addPick(v, p.name)}>
                          <span>
                            {v.name ? `${p.name} – ${v.name}` : p.name} <span className="text-xs text-slate-500">{v.sku}</span>
                          </span>
                          <span className="num font-medium">{formatMoney(v.sellPrice)}</span>
                        </button>
                      </li>
                    )),
                )}
                {found.data.items.length === 0 && <li className="px-3 py-2 text-sm text-slate-500">No matches</li>}
              </ul>
            )}
            <ul className="mt-3 space-y-2">
              {picks.map((p) => (
                <li key={p.variantId} className="flex items-center justify-between gap-2 text-sm" data-testid="exchange-new-line">
                  <div>
                    <div className="font-medium text-slate-900">{p.description}</div>
                    <div className="text-xs text-slate-500">
                      {p.sku} · {formatMoney(p.price)}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button variant="secondary" size="sm" aria-label="Decrease" onClick={() => setPicks(picks.map((x) => (x.variantId === p.variantId ? { ...x, quantity: Math.max(1, x.quantity - 1) } : x)))}>
                      <Minus className="size-4" />
                    </Button>
                    <span className="num w-8 text-center">{p.quantity}</span>
                    <Button variant="secondary" size="sm" aria-label="Increase" onClick={() => setPicks(picks.map((x) => (x.variantId === p.variantId ? { ...x, quantity: x.quantity + 1 } : x)))}>
                      <Plus className="size-4" />
                    </Button>
                    <Button variant="ghost" size="sm" aria-label={`Remove ${p.description}`} onClick={() => setPicks(picks.filter((x) => x.variantId !== p.variantId))}>
                      <X className="size-4" />
                    </Button>
                  </div>
                </li>
              ))}
              {picks.length === 0 && <li className="text-sm text-slate-500">Search and add the items the customer is taking instead.</li>}
            </ul>
          </section>
        </div>

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
          </div>
          <div className="space-y-3">
            <div className="rounded-lg bg-navy-50 px-4 py-3 text-sm" data-testid="exchange-summary">
              <div className="flex justify-between">
                <span>Returned value</span>
                <span className="num">{formatMoney(quote.data?.returnedValue ?? 0)}</span>
              </div>
              <div className="flex justify-between">
                <span>New items</span>
                <span className="num">{formatMoney(quote.data?.issuedValue ?? 0)}</span>
              </div>
              <div className="mt-1 flex items-baseline justify-between border-t border-navy-100 pt-1">
                <span className="font-medium text-navy-900">{owes ? "Customer pays" : refunds ? "Refund to customer" : "Even exchange"}</span>
                <span className="num text-2xl font-semibold text-navy-950" data-testid="exchange-difference">
                  {formatMoney(Math.abs(diffCents) / 100)}
                </span>
              </div>
            </div>
            {(owes || refunds) && (
              <div className="grid grid-cols-[7rem_1fr] items-end gap-2">
                <Select aria-label="Settlement method" value={method} onChange={(e) => setMethod(e.target.value)}>
                  {METHODS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </Select>
                {owes && method === "cash" ? (
                  <Input aria-label="Cash received" inputMode="decimal" placeholder={`Cash received (${(diffCents / 100).toFixed(2)})`} value={tendered} onChange={(e) => setTendered(e.target.value)} />
                ) : method !== "cash" ? (
                  <Input aria-label="Payment reference" placeholder="Reference (terminal or transfer ID)" value={reference} onChange={(e) => setReference(e.target.value)} />
                ) : (
                  <span className="pb-2 text-sm text-slate-500">Paid out of the drawer</span>
                )}
              </div>
            )}
            {refunds && method !== "cash" && <Alert tone="amber">Card and online refunds stay pending until the payment provider confirms them.</Alert>}
            {quote.isError && <Alert>{errorMessage(quote.error)}</Alert>}
            {error && <Alert>{error}</Alert>}
            {problems.length > 0 && selected.length + picks.length > 0 && <p className="text-xs text-slate-500">{problems[0]}</p>}
            <Button size="lg" className="w-full" loading={submit.isPending} disabled={!valid} onClick={go} data-testid="complete-exchange">
              <ArrowLeftRight className="size-4" /> Complete exchange
            </Button>
          </div>
        </div>
      </Card></div>
      <ExchangeReceiptModal exchangeId={done?.id ?? null} onClose={() => (setDone(null), onDone())} />
    </>
  );
}

function ExchangeReceiptBody({ r }: { r: ExchangeReceipt }) {
  return (
    <div className="receipt" data-testid="exchange-receipt">
      <h1>{r.issued.business.name}</h1>
      <div className="center strong">EXCHANGE {r.exchangeNumber}</div>
      <div className="row">
        <span>Original invoice</span>
        <span>{r.originalInvoice}</span>
      </div>
      <div className="row">
        <span>Processed by</span>
        <span>{r.processedBy}</span>
      </div>
      <hr className="rule" />
      <div className="strong">Returned</div>
      {r.returned.items.map((i, k) => (
        <div className="row" key={k}>
          <span>
            {i.quantity} × {i.description}
          </span>
          <span>{i.refundAmount}</span>
        </div>
      ))}
      <div className="row strong">
        <span>Returned value</span>
        <span>{r.returnedValue}</span>
      </div>
      <hr className="rule" />
      <div className="strong">New items</div>
      {r.issued.items.map((i, k) => (
        <div className="row" key={k}>
          <span>
            {formatQty(i.quantity)} × {i.description}
          </span>
          <span>{i.lineTotal}</span>
        </div>
      ))}
      <div className="row strong">
        <span>New items value</span>
        <span>{r.issuedValue}</span>
      </div>
      <hr className="rule" />
      <div className="row strong">
        <span>{r.direction === "PAY" ? "Paid by customer" : r.direction === "REFUND" ? "Refunded to customer" : "Difference"}</span>
        <span>{r.difference}</span>
      </div>
      <div className="center muted">{r.issued.footer ?? "Thank you!"}</div>
    </div>
  );
}

function ExchangeReceiptModal({ exchangeId, onClose }: { exchangeId: string | null; onClose: () => void }) {
  const q = useQuery({ queryKey: ["exchange-receipt", exchangeId], queryFn: () => api.exchangeReceipt(exchangeId!), enabled: !!exchangeId, staleTime: Infinity });
  const printRoot = document.getElementById("print-root");
  return (
    <Modal
      open={!!exchangeId}
      title="Exchange receipt"
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Done
          </Button>
          <Button disabled={!q.data} onClick={() => void printReceipt()}>
            <Printer className="size-4" /> Print receipt
          </Button>
        </>
      }
    >
      {q.isPending && <LoadingBlock label="Loading receipt…" />}
      {q.isError && <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />}
      {q.data && (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white py-2 shadow-inner">
          <ExchangeReceiptBody r={q.data} />
        </div>
      )}
      {q.data && printRoot && createPortal(<ExchangeReceiptBody r={q.data} />, printRoot)}
    </Modal>
  );
}

function History() {
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["exchanges", page], queryFn: () => api.exchanges({ page, pageSize: 20 }), placeholderData: keepPreviousData });
  return (
    <Card className="overflow-hidden">
      {q.isPending ? (
        <LoadingBlock />
      ) : q.isError ? (
        <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />
      ) : q.data.items.length === 0 ? (
        <EmptyState title="No exchanges yet" />
      ) : (
        <table className="w-full text-left text-sm" data-testid="exchange-history">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Exchange</th>
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3">Invoice</th>
              <th className="px-4 py-3 text-right">Returned</th>
              <th className="px-4 py-3 text-right">New items</th>
              <th className="px-4 py-3 text-right">Difference</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {q.data.items.map((x) => (
              <tr key={x.id}>
                <td className="px-4 py-3 font-medium">{x.exchangeNumber}</td>
                <td className="px-4 py-3 text-slate-600">{formatDateTime(x.createdAt)}</td>
                <td className="px-4 py-3">{x.originalSale.saleNumber}</td>
                <td className="num px-4 py-3 text-right">{formatMoney(x.returnedValue)}</td>
                <td className="num px-4 py-3 text-right">{formatMoney(x.issuedValue)}</td>
                <td className="num px-4 py-3 text-right">
                  <Badge tone={Number(x.difference) > 0 ? "green" : Number(x.difference) < 0 ? "amber" : "slate"}>{formatMoney(x.difference)}</Badge>
                </td>
                <td className="px-4 py-3 text-right">
                  <Button variant="ghost" size="sm" onClick={() => setOpen(x.id)}>
                    <Printer className="size-4" /> Receipt
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {q.data && q.data.total > 20 && (
        <div className="flex justify-end gap-2 border-t border-slate-200 p-3">
          <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Prev
          </Button>
          <Button variant="secondary" size="sm" disabled={page * 20 >= q.data.total} onClick={() => setPage(page + 1)}>
            Next
          </Button>
        </div>
      )}
      <ExchangeReceiptModal exchangeId={open} onClose={() => setOpen(null)} />
    </Card>
  );
}

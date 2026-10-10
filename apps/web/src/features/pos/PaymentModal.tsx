import { useMemo, useRef, useState } from "react";
import { Banknote, CreditCard, Globe, Plus, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api";
import { ApiError, NetworkError, errorMessage } from "@/api/client";
import type { Quote, SaleInput } from "@/api/types";
import { useCart } from "@/cart/CartContext";
import { Alert } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { resolveAttempt, type SalePayload } from "@/lib/checkoutAttempt";
import { formatMoney, fromCents, toCents } from "@/lib/format";

type Method = "cash" | "card" | "online";
interface Row {
  key: number;
  method: Method;
  amount: string;
  reference: string;
}

const METHODS: { code: Method; label: string; icon: typeof Banknote }[] = [
  { code: "cash", label: "Cash", icon: Banknote },
  { code: "card", label: "Card", icon: CreditCard },
  { code: "online", label: "Online", icon: Globe },
];

let rowKey = 0;
const newRow = (method: Method, amount = ""): Row => ({ key: ++rowKey, method, amount, reference: "" });

function quickCash(totalCents: number): number[] {
  const out = new Set<number>([totalCents]);
  for (const step of [10_000, 50_000, 100_000, 500_000]) {
    const v = Math.ceil(totalCents / step) * step;
    if (v > totalCents) out.add(v);
  }
  return [...out].slice(0, 4);
}

interface Props {
  open: boolean;
  quote: Quote;
  onClose: () => void;
  onPaid: (saleId: string) => void;
}

export function PaymentModal(props: Props) {
  if (!props.open) return null;
  return <PaymentForm {...props} />;
}

function PaymentForm({ quote, onClose, onPaid }: Props) {
  const { cart, dispatch } = useCart();
  const totalCents = toCents(quote.grandTotal);
  const registers = useQuery({ queryKey: ["registers"], queryFn: api.registers, staleTime: Infinity });

  const restored = useMemo(() => {
    if (!cart.attempt?.unknownOutcome) return null;
    try {
      return JSON.parse(cart.attempt.fingerprint) as SalePayload;
    } catch {
      return null;
    }
  }, [cart.attempt]);

  const [rows, setRows] = useState<Row[]>(() =>
    restored
      ? restored.payments.map((p) => ({ key: ++rowKey, method: p.method as Method, amount: String(p.amount), reference: p.reference ?? "" }))
      : [newRow("cash", String(fromCents(totalCents)))],
  );
  const [registerId, setRegisterId] = useState<number | null>(restored?.registerId ?? null);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const unknown = !!cart.attempt?.unknownOutcome;
  const effectiveRegister = registerId ?? Number(localStorage.getItem("pos.register"));
  const register = registers.data?.find((r) => r.id === effectiveRegister) ?? registers.data?.[0];

  const paidCents = rows.reduce((s, r) => s + toCents(r.amount || 0), 0);
  const nonCash = rows.filter((r) => r.method !== "cash").reduce((s, r) => s + toCents(r.amount || 0), 0);
  const cashCents = paidCents - nonCash;
  const remaining = Math.max(0, totalCents - paidCents);
  const change = Math.max(0, paidCents - totalCents);

  const problems: string[] = [];
  if (rows.some((r) => !(Number(r.amount) > 0))) problems.push("Enter an amount for every payment.");
  if (rows.some((r) => r.method !== "cash" && !r.reference.trim())) problems.push("Card and online payments need a reference.");
  if (nonCash > totalCents) problems.push("Card and online payments cannot exceed the total.");
  if (change > cashCents) problems.push("Change cannot exceed the cash received.");
  const underpaid = paidCents < totalCents;
  const valid = problems.length === 0 && !underpaid && !!register;

  const update = (key: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  async function submit() {
    if (inFlight.current || !valid || !register) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    localStorage.setItem("pos.register", String(register.id));

    const payload: SalePayload = {
      registerId: register.id,
      items: cart.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, ...(l.discount ? { discount: l.discount } : {}) })),
      ...(cart.discount ? { discount: cart.discount } : {}),
      ...(cart.customer ? { customerId: cart.customer.id } : {}),
      payments: rows.map((r) => ({ method: r.method, amount: Number(r.amount), ...(r.method !== "cash" ? { reference: r.reference.trim() } : {}) })),
    };

    let attempt;
    try {
      attempt = resolveAttempt(cart.attempt, payload);
    } catch {
      setError("The previous attempt may have gone through. Use “Check status” before changing anything.");
      inFlight.current = false;
      setSubmitting(false);
      return;
    }
    dispatch({ type: "attempt", attempt });

    try {
      const sale = await api.createSale({ id: attempt.id, ...payload } as SaleInput);
      onPaid(sale.id);
    } catch (e) {
      if (e instanceof NetworkError) {
        dispatch({ type: "attempt", attempt: { ...attempt, unknownOutcome: true } });
        setError("Connection lost. The sale may or may not have been recorded. Retry (it is safe) or check its status.");
      } else if (e instanceof ApiError && e.status === 401) {
        setError("Your session expired. Sign in again; your cart and payment will be kept.");
      } else if (e instanceof ApiError && e.status === 402) {
        setError(`Underpayment: ${e.message}`);
      } else if (e instanceof ApiError && e.status === 409) {
        setError(`Stock or sale conflict: ${e.message}`);
      } else {
        setError(errorMessage(e));
      }
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  async function checkStatus() {
    if (!cart.attempt) return;
    setChecking(true);
    setError(null);
    try {
      const sale = await api.sale(cart.attempt.id);
      onPaid(sale.id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        dispatch({ type: "attempt", attempt: null });
        setError("The sale was not recorded. You can edit the payment and try again.");
      } else {
        setError(errorMessage(e));
      }
    } finally {
      setChecking(false);
    }
  }

  return (
    <Modal
      open
      title="Payment"
      size="md"
      locked={submitting || unknown}
      onClose={onClose}
      footer={
        <>
          {unknown && (
            <Button variant="secondary" loading={checking} disabled={submitting} onClick={checkStatus}>
              Check status
            </Button>
          )}
          <Button variant="secondary" onClick={onClose} disabled={submitting || unknown}>
            Back to cart
          </Button>
          <Button variant="success" size="lg" onClick={submit} loading={submitting} disabled={!valid || checking}>
            {unknown ? "Retry payment" : `Complete ${formatMoney(quote.grandTotal)}`}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-end justify-between rounded-xl bg-navy-900 p-4 text-white">
          <span className="text-sm text-navy-200">Amount due</span>
          <span className="num text-3xl font-bold" data-testid="amount-due">
            {formatMoney(quote.grandTotal)}
          </span>
        </div>

        {error && <Alert>{error}</Alert>}
        {unknown && !error && <Alert tone="amber">A previous attempt has an unknown outcome. Retry unchanged or check status.</Alert>}

        {registers.data && registers.data.length > 1 && (
          <Select label="Register" value={register?.id ?? ""} disabled={unknown} onChange={(e) => setRegisterId(Number(e.target.value))}>
            {registers.data.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        )}

        <div className="space-y-3">
          {rows.map((r, idx) => (
            <fieldset key={r.key} disabled={unknown || submitting} className="rounded-xl border border-slate-200 p-3" data-testid="payment-row">
              <div className="mb-3 flex items-center gap-2">
                <div className="grid flex-1 grid-cols-3 gap-1 rounded-lg bg-slate-100 p-1" role="radiogroup" aria-label="Payment method">
                  {METHODS.map(({ code, label, icon: Icon }) => (
                    <button
                      key={code}
                      type="button"
                      role="radio"
                      aria-checked={r.method === code}
                      onClick={() => update(r.key, { method: code })}
                      className={`flex h-10 items-center justify-center gap-1.5 rounded-md text-sm font-medium ${r.method === code ? "bg-white text-navy-900 shadow-sm" : "text-slate-500"}`}
                    >
                      <Icon className="size-4" />
                      {label}
                    </button>
                  ))}
                </div>
                {rows.length > 1 && (
                  <button type="button" aria-label="Remove payment" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} className="grid size-9 place-items-center rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-600">
                    <X className="size-4" />
                  </button>
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Input label={r.method === "cash" ? "Cash received" : "Amount"} inputMode="decimal" value={r.amount} autoFocus={idx === 0} onChange={(e) => update(r.key, { amount: e.target.value })} />
                {r.method !== "cash" && <Input label={r.method === "card" ? "Card slip / auth no." : "Transaction ref."} value={r.reference} onChange={(e) => update(r.key, { reference: e.target.value })} />}
              </div>
              {r.method === "cash" && rows.length === 1 && !unknown && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {quickCash(totalCents).map((c) => (
                    <button key={c} type="button" onClick={() => update(r.key, { amount: String(fromCents(c)) })} className="h-9 rounded-lg border border-slate-300 px-3 text-sm font-medium text-navy-800 hover:bg-navy-50">
                      {c === totalCents ? "Exact" : formatMoney(fromCents(c))}
                    </button>
                  ))}
                </div>
              )}
            </fieldset>
          ))}
        </div>

        {rows.length < 3 && !unknown && (
          <Button variant="ghost" size="sm" icon={<Plus className="size-4" />} onClick={() => setRows((rs) => [...rs, newRow("card", remaining > 0 ? String(fromCents(remaining)) : "")])}>
            Split payment
          </Button>
        )}

        <dl className="space-y-1 rounded-xl bg-slate-50 p-3 text-sm">
          <div className="flex justify-between">
            <dt className="text-slate-500">Tendered</dt>
            <dd className="num">{formatMoney(fromCents(paidCents))}</dd>
          </div>
          {underpaid ? (
            <div className="flex justify-between font-semibold text-red-600">
              <dt>Remaining</dt>
              <dd className="num" data-testid="remaining">
                {formatMoney(fromCents(remaining))}
              </dd>
            </div>
          ) : (
            <div className="flex justify-between text-lg font-semibold text-emerald-700">
              <dt>Change</dt>
              <dd className="num" data-testid="change">
                {formatMoney(fromCents(change))}
              </dd>
            </div>
          )}
        </dl>
        {problems.map((p) => (
          <p key={p} className="text-xs text-red-600">
            {p}
          </p>
        ))}
      </div>
    </Modal>
  );
}

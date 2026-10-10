import { useState } from "react";
import { Minus, Percent, Plus, ShoppingCart, Trash2 } from "lucide-react";
import type { Discount, Quote } from "@/api/types";
import { useCart } from "@/cart/CartContext";
import { Alert, Badge } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { formatMoney, formatQty } from "@/lib/format";
import { DiscountModal } from "./DiscountModal";
import { CustomerPicker } from "./PosExtras";

interface Props {
  quote?: Quote;
  quoting: boolean;
  quoteError: string | null;
  locked: boolean;
  onPay: () => void;
}

const describe = (d?: Discount) => (d ? (d.type === "PERCENT" ? `${d.value}%` : formatMoney(d.value)) : "");

export function CartPanel({ quote, quoting, quoteError, locked, onPay }: Props) {
  const { cart, dispatch } = useCart();
  const [discountFor, setDiscountFor] = useState<string | "cart" | null>(null);
  const empty = cart.lines.length === 0;
  const lineQuote = (id: string) => quote?.lines.find((l) => l.variantId === id);
  const canPay = !empty && !locked && !!quote?.canCheckout && !quoting && !quoteError;

  const target = discountFor === "cart" ? cart.discount : cart.lines.find((l) => l.variantId === discountFor)?.discount;

  return (
    <section className="flex h-full min-h-0 flex-col bg-white" aria-label="Current sale">
      <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <h2 className="flex items-center gap-2 font-semibold text-navy-950">
          <ShoppingCart className="size-5 text-navy-700" /> Current sale
          {!empty && <Badge tone="navy">{cart.lines.length}</Badge>}
        </h2>
        <Button variant="ghost" size="sm" disabled={empty || locked} onClick={() => dispatch({ type: "clear" })} icon={<Trash2 className="size-4" />}>
          Clear
        </Button>
      </header>

      <CustomerPicker disabled={locked} />
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="cart-lines">
        {empty ? (
          <div className="grid h-full place-items-center p-8 text-center text-sm text-slate-400">
            <div>
              <ShoppingCart className="mx-auto mb-2 size-8" />
              Scan a barcode or search to add items
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {cart.lines.map((l) => {
              const q = lineQuote(l.variantId);
              return (
                <li key={l.variantId} className="px-4 py-3" data-testid="cart-line">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-900">{l.name}</p>
                      <p className="text-xs text-slate-500">
                        {l.sku}
                        {q && ` · ${formatMoney(q.unitPrice)} each`}
                      </p>
                    </div>
                    <p className="num shrink-0 text-sm font-semibold text-slate-900">{q ? formatMoney(q.lineTotal) : "…"}</p>
                  </div>
                  {q?.insufficientStock && (
                    <p className="mt-1 text-xs font-medium text-red-600">Only {formatQty(q.onHand)} in stock</p>
                  )}
                  <div className="mt-2 flex items-center gap-2">
                    <div className="flex items-center rounded-lg border border-slate-300">
                      <button
                        aria-label={`Decrease ${l.name}`}
                        disabled={locked || l.quantity <= 1}
                        onClick={() => dispatch({ type: "setQty", variantId: l.variantId, quantity: l.quantity - 1 })}
                        className="grid size-9 place-items-center text-slate-600 hover:bg-slate-50 disabled:text-slate-300"
                      >
                        <Minus className="size-4" />
                      </button>
                      <QtyInput value={l.quantity} disabled={locked} label={`Quantity for ${l.name}`} onCommit={(n) => dispatch({ type: "setQty", variantId: l.variantId, quantity: n })} />
                      <button
                        aria-label={`Increase ${l.name}`}
                        disabled={locked}
                        onClick={() => dispatch({ type: "setQty", variantId: l.variantId, quantity: l.quantity + 1 })}
                        className="grid size-9 place-items-center text-slate-600 hover:bg-slate-50 disabled:text-slate-300"
                      >
                        <Plus className="size-4" />
                      </button>
                    </div>
                    <button
                      disabled={locked}
                      onClick={() => setDiscountFor(l.variantId)}
                      aria-label={`Discount for ${l.name}`}
                      className={`inline-flex h-9 items-center gap-1 rounded-lg border px-2.5 text-xs font-medium ${l.discount ? "border-navy-300 bg-navy-50 text-navy-800" : "border-slate-300 text-slate-500 hover:bg-slate-50"}`}
                    >
                      <Percent className="size-3.5" />
                      {l.discount ? `-${describe(l.discount)}` : "Discount"}
                    </button>
                    <button
                      disabled={locked}
                      onClick={() => dispatch({ type: "remove", variantId: l.variantId })}
                      aria-label={`Remove ${l.name}`}
                      className="ml-auto grid size-9 place-items-center rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <footer className="space-y-3 border-t border-slate-200 bg-slate-50/60 p-4">
        {quoteError && <Alert>{quoteError}</Alert>}
        {quote && !quote.canCheckout && !quoteError && <Alert tone="amber">Some items exceed available stock. Reduce quantities to continue.</Alert>}
        <dl className="space-y-1 text-sm">
          <Row label="Subtotal" value={quote?.subtotal} />
          <div className="flex items-center justify-between">
            <dt className="text-slate-500">
              <button disabled={empty || locked} onClick={() => setDiscountFor("cart")} className="inline-flex items-center gap-1 font-medium text-navy-700 hover:underline disabled:text-slate-300 disabled:no-underline">
                <Percent className="size-3.5" />
                {cart.discount ? `Sale discount (${describe(cart.discount)})` : "Add sale discount"}
              </button>
            </dt>
            <dd className="num text-slate-700">{quote && Number(quote.discountTotal) > 0 ? `-${formatMoney(quote.discountTotal)}` : ""}</dd>
          </div>
          {quote?.taxEnabled && <Row label="VAT" value={quote.taxTotal} />}
        </dl>
        <div className="flex items-end justify-between border-t border-slate-200 pt-3">
          <span className="text-sm font-medium text-slate-600">Total</span>
          <span className="num text-3xl font-bold text-navy-950" data-testid="cart-total">
            {quote ? formatMoney(quote.grandTotal) : formatMoney(0)}
          </span>
        </div>
        <Button size="lg" variant="primary" className="w-full" disabled={!canPay} loading={quoting && !empty} onClick={onPay}>
          Charge {quote && canPay ? formatMoney(quote.grandTotal) : ""}
        </Button>
      </footer>

      <DiscountModal
        open={discountFor !== null}
        title={discountFor === "cart" ? "Sale discount" : "Item discount"}
        value={target}
        onClose={() => setDiscountFor(null)}
        onApply={(d) => (discountFor === "cart" ? dispatch({ type: "cartDiscount", discount: d }) : dispatch({ type: "lineDiscount", variantId: discountFor!, discount: d }))}
      />
    </section>
  );
}

function Row({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-slate-500">{label}</dt>
      <dd className="num text-slate-700">{value !== undefined ? formatMoney(value) : ""}</dd>
    </div>
  );
}

function QtyInput({ value, onCommit, disabled, label }: { value: number; onCommit: (n: number) => void; disabled: boolean; label: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    const n = Number(draft);
    if (draft !== null && n > 0 && n <= 100000) onCommit(n);
    setDraft(null);
  };
  return (
    <input
      aria-label={label}
      inputMode="decimal"
      disabled={disabled}
      value={draft ?? String(value)}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && (e.currentTarget.blur(), e.stopPropagation())}
      className="num h-9 w-14 border-x border-slate-300 text-center text-sm font-medium focus:outline-none"
    />
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ScanBarcode, Search } from "lucide-react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import { ApiError, errorMessage } from "@/api/client";
import type { Variant, Product } from "@/api/types";
import { useCart } from "@/cart/CartContext";
import { Alert, Badge, EmptyState } from "@/components/ui/Card";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { formatMoney, formatQty } from "@/lib/format";
import { parseScanInput } from "@/lib/scan";
import { ShiftBanner } from "./PosExtras";
import { CartPanel } from "./CartPanel";
import { PaymentModal } from "./PaymentModal";
import { ReceiptModal } from "./ReceiptModal";

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const variantLabel = (p: Product, v: Variant) => (v.name ? `${p.name} – ${v.name}` : p.name);

export function PosPage() {
  const { cart, dispatch } = useCart();
  const toast = useToast();
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [receiptId, setReceiptId] = useState<string | null>(null);

  const locked = !!cart.attempt?.unknownOutcome;
  const search = useDebounced(text.trim(), 250);
  const searchTerm = parseScanInput(search)?.code ?? "";

  const results = useQuery({
    queryKey: ["pos-search", searchTerm],
    queryFn: () => api.products({ search: searchTerm, pageSize: 24, active: true }),
    enabled: searchTerm.length >= 2,
    placeholderData: keepPreviousData,
  });

  // Server-authoritative totals: every cart change is re-priced by the backend.
  const items = useMemo(() => cart.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, ...(l.discount ? { discount: l.discount } : {}) })), [cart.lines]);
  const debouncedItems = useDebounced(items, 200);
  const debouncedDiscount = useDebounced(cart.discount, 200);
  const quoteQ = useQuery({
    queryKey: ["quote", debouncedItems, debouncedDiscount],
    queryFn: ({ signal }) => api.quote(debouncedItems, debouncedDiscount, signal),
    enabled: debouncedItems.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const settled = debouncedItems === items || JSON.stringify(debouncedItems) === JSON.stringify(items);
  const quoting = quoteQ.isFetching || !settled || debouncedDiscount !== cart.discount;
  const quoteError = quoteQ.isError ? errorMessage(quoteQ.error) : null;
  const quote = cart.lines.length ? quoteQ.data : undefined;

  const addVariant = useCallback(
    (v: { id: string; sku: string; name: string | null }, productName: string, quantity = 1) => {
      dispatch({ type: "add", line: { variantId: v.id, sku: v.sku, name: v.name ? `${productName} – ${v.name}` : productName }, quantity });
    },
    [dispatch],
  );

  async function submitScan() {
    const parsed = parseScanInput(text);
    if (!parsed || locked) return;
    setScanError(null);
    setScanning(true);
    try {
      const submitted = text;
      const v = await api.lookup(parsed.code);
      if (!v.isActive || !v.product.isActive) throw new ApiError(404, "inactive");
      addVariant(v, v.product.name, parsed.quantity);
      // Keep anything typed while the lookup was in flight (a fast scanner may already be on the next item).
      setText((t) => (t === submitted ? "" : t));
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        // Not an exact barcode/SKU: leave the text so the name search results remain visible.
        setScanError(`No exact barcode or SKU match for “${parsed.code}”. Pick from the results below.`);
      } else {
        setScanError(errorMessage(e));
      }
    } finally {
      setScanning(false);
      inputRef.current?.focus();
    }
  }

  // Scanners type like a keyboard: route stray keystrokes into the scan box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
      const a = document.activeElement;
      if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT")) return;
      if (document.querySelector('[role="dialog"]')) return;
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => inputRef.current?.focus(), []);

  const onPaid = (saleId: string) => {
    dispatch({ type: "clear" });
    setPaying(false);
    setReceiptId(saleId);
    setText("");
    void qc.invalidateQueries({ queryKey: ["pos-search"] });
    void qc.invalidateQueries({ queryKey: ["dashboard"] });
    void qc.invalidateQueries({ queryKey: ["products"] });
    void qc.invalidateQueries({ queryKey: ["inventory"] });
    void qc.invalidateQueries({ queryKey: ["sales"] });
    toast.success("Sale completed");
  };

  const variants = (results.data?.items ?? []).flatMap((p) => p.variants.filter((v) => v.isActive).map((v) => ({ p, v })));

  return (
    <div className="flex h-full flex-col lg:flex-row">
      <div className="flex min-h-0 flex-1 flex-col p-4 lg:p-6">
        <ShiftBanner />
        <div className="relative">
          <ScanBarcode className="pointer-events-none absolute left-4 top-1/2 size-6 -translate-y-1/2 text-navy-600" />
          <input
            ref={inputRef}
            data-testid="scan-input"
            aria-label="Scan barcode or search products"
            autoComplete="off"
            value={text}
            disabled={locked}
            onChange={(e) => {
              setText(e.target.value);
              setScanError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submitScan();
              }
            }}
            placeholder="Scan barcode, or type name / SKU (try 3*barcode)"
            className="h-14 w-full rounded-xl border border-slate-300 bg-white pl-14 pr-12 text-lg shadow-card placeholder:text-slate-400 focus:border-navy-500 focus:outline-none focus:ring-4 focus:ring-navy-100 disabled:bg-slate-100"
          />
          {(scanning || results.isFetching) && <Spinner className="absolute right-4 top-1/2 size-5 -translate-y-1/2 text-navy-600" />}
        </div>

        {locked && (
          <div className="mt-3">
            <Alert tone="amber">
              A payment is awaiting confirmation. <button className="font-semibold underline" onClick={() => setPaying(true)}>Resolve it</button> before changing the cart.
            </Alert>
          </div>
        )}
        {scanError && (
          <div className="mt-3">
            <Alert tone="amber">{scanError}</Alert>
          </div>
        )}

        <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
          {searchTerm.length < 2 ? (
            <EmptyState icon={<Search className="size-6" />} title="Ready to scan" hint="Scan an item or type at least 2 characters to search by name, SKU or barcode." />
          ) : results.isError ? (
            <Alert>{errorMessage(results.error)}</Alert>
          ) : variants.length === 0 && !results.isFetching ? (
            <EmptyState title="No matching products" hint={`Nothing found for “${searchTerm}”.`} />
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="search-results">
              {variants.map(({ p, v }) => {
                const onHand = v.stockLevel ? Number(v.stockLevel.onHand) : 0;
                const out = p.trackStock && onHand <= 0;
                return (
                  <li key={v.id}>
                    <button
                      disabled={locked}
                      onClick={() => {
                        addVariant(v, p.name);
                        setText("");
                        inputRef.current?.focus();
                      }}
                      className="flex h-full w-full flex-col rounded-xl border border-slate-200 bg-white p-3 text-left shadow-card transition hover:border-navy-300 hover:shadow-md active:scale-[0.99] disabled:opacity-50"
                    >
                      <span className="line-clamp-2 text-sm font-medium text-slate-900">{variantLabel(p, v)}</span>
                      <span className="mt-0.5 text-xs text-slate-500">{v.sku}</span>
                      <span className="mt-2 flex items-center justify-between">
                        <span className="num font-semibold text-navy-900">{formatMoney(v.sellPrice)}</span>
                        {p.trackStock && (out ? <Badge tone="red">Out of stock</Badge> : <Badge tone={onHand <= Number(v.reorderLevel) ? "amber" : "green"}>{formatQty(onHand)} left</Badge>)}
                      </span>
                      {out && (
                        <span className="mt-1 flex items-center gap-1 text-xs text-red-600">
                          <AlertTriangle className="size-3" /> Cannot be sold
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <div className="h-[46vh] shrink-0 border-t border-slate-200 lg:h-auto lg:w-[24rem] lg:border-l lg:border-t-0 xl:w-[26rem]">
        <CartPanel quote={quote} quoting={quoting} quoteError={quoteError} locked={locked} onPay={() => setPaying(true)} />
      </div>

      {quote && <PaymentModal open={paying} quote={quote} onClose={() => setPaying(false)} onPaid={onPaid} />}
      <ReceiptModal saleId={receiptId} onClose={() => setReceiptId(null)} />
    </div>
  );
}

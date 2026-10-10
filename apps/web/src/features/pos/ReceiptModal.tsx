import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Printer } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api";
import { errorMessage } from "@/api/client";
import type { Receipt } from "@/api/types";
import { Button } from "@/components/ui/Button";
import { ErrorState, LoadingBlock } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { formatDateTime, formatQty } from "@/lib/format";
import { printReceipt } from "@/hardware";

const METHOD_LABEL: Record<string, string> = { cash: "Cash", card: "Card", online: "Online" };

/** 80 mm receipt body. The same markup is shown in the preview and in the print layout. */
export function ReceiptView({ r }: { r: Receipt }) {
  // The API returns receipt amounts already formatted (e.g. "Rs. 1,500.00"); show them exactly as issued.
  const money = (v: string) => v;
  const positive = (v: string) => Number(v.replace(/[^0-9.]/g, "")) > 0;
  return (
    <div className="receipt" data-testid="receipt">
      <h1>{r.business.name}</h1>
      <div className="center muted">
        {r.business.address && <div>{r.business.address}</div>}
        {r.business.phone && <div>Tel: {r.business.phone}</div>}
        {r.business.vatNumber && <div>VAT No: {r.business.vatNumber}</div>}
        {r.header && <div>{r.header}</div>}
      </div>
      <hr className="rule" />
      <div className="row">
        <span>Invoice</span>
        <span className="strong">{r.invoiceNumber}</span>
      </div>
      <div className="row">
        <span>Date</span>
        <span>{formatDateTime(r.issuedAt)}</span>
      </div>
      <div className="row">
        <span>Cashier</span>
        <span>{r.cashier}</span>
      </div>
      {r.register && (
        <div className="row">
          <span>Register</span>
          <span>{r.register}</span>
        </div>
      )}
      {r.customer && (
        <div className="row">
          <span>Customer</span>
          <span>{r.customer.name}</span>
        </div>
      )}
      <hr className="rule" />
      {r.items.map((it, i) => (
        <div key={i} style={{ marginBottom: 3 }}>
          <div>{it.description}</div>
          <div className="row muted">
            <span>
              {formatQty(it.quantity)} x {money(it.unitPrice)}
            </span>
            <span>{money(it.lineTotal)}</span>
          </div>
          {it.discount && (
            <div className="row muted">
              <span>Discount</span>
              <span>-{money(it.discount)}</span>
            </div>
          )}
        </div>
      ))}
      <hr className="rule" />
      <div className="row">
        <span>Subtotal</span>
        <span>{money(r.totals.subtotal)}</span>
      </div>
      {positive(r.totals.discount) && (
        <div className="row">
          <span>Discount</span>
          <span>-{money(r.totals.discount)}</span>
        </div>
      )}
      {r.totals.tax !== null && (
        <div className="row">
          <span>VAT</span>
          <span>{money(r.totals.tax)}</span>
        </div>
      )}
      <div className="row big">
        <span>TOTAL</span>
        <span>{money(r.totals.grandTotal)}</span>
      </div>
      <hr className="rule" />
      {r.payments.map((p, i) => (
        <div key={i} className="row">
          <span>
            {METHOD_LABEL[p.method] ?? p.method}
            {p.reference ? ` (${p.reference})` : ""}
          </span>
          <span>{money(p.amount)}</span>
        </div>
      ))}
      <div className="row">
        <span>Paid</span>
        <span>{money(r.totals.paid)}</span>
      </div>
      <div className="row strong">
        <span>Change</span>
        <span>{money(r.totals.change)}</span>
      </div>
      {r.tax && r.tax.breakdown.length > 0 && (
        <>
          <hr className="rule" />
          <div className="muted">
            {r.tax.breakdown.map((b, i) => (
              <div key={i} className="row">
                <span>
                  VAT {b.ratePct}% on {money(b.taxableAmount)}
                </span>
                <span>{money(b.taxAmount)}</span>
              </div>
            ))}
          </div>
        </>
      )}
      <hr className="rule" />
      <div className="center muted">{r.footer ?? "Thank you!"}</div>
    </div>
  );
}

interface Props {
  saleId: string | null;
  onClose: () => void;
  /** Opens the print dialog automatically once the receipt has loaded. */
  autoPrint?: boolean;
  title?: string;
}

export function ReceiptModal({ saleId, onClose, autoPrint, title = "Sale complete" }: Props) {
  const q = useQuery({ queryKey: ["receipt", saleId], queryFn: () => api.receipt(saleId!), enabled: !!saleId, staleTime: Infinity });
  const printRoot = document.getElementById("print-root");

  useEffect(() => {
    if (autoPrint && q.data) {
      const t = setTimeout(() => void printReceipt(), 250);
      return () => clearTimeout(t);
    }
  }, [autoPrint, q.data]);

  return (
    <Modal
      open={!!saleId}
      title={title}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            New sale
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
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white py-2 shadow-inner">
          <ReceiptView r={q.data} />
        </div>
      )}
      {q.data && printRoot && createPortal(<ReceiptView r={q.data} />, printRoot)}
    </Modal>
  );
}

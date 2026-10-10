import { useState } from "react";
import { ChevronLeft, ChevronRight, Printer } from "lucide-react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import { errorMessage } from "@/api/client";
import { Badge, Card, EmptyState, ErrorState, LoadingBlock, PageHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Select, Textarea } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { useAuth } from "@/auth/AuthProvider";
import { Alert } from "@/components/ui/Card";
import { formatDateTime, formatMoney } from "@/lib/format";
import { ReceiptModal } from "@/features/pos/ReceiptModal";

const PAGE = 20;

export function SalesPage() {
  const [page, setPage] = useState(1);
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [voiding, setVoiding] = useState<{ id: string; saleNumber: string } | null>(null);
  const { user } = useAuth();
  const canVoid = user?.role === "ADMIN" || user?.role === "MANAGER";
  const q = useQuery({ queryKey: ["sales", page, status], queryFn: () => api.sales({ page, pageSize: PAGE, status: status || undefined }), placeholderData: keepPreviousData });
  const pages = q.data ? Math.max(1, Math.ceil(q.data.total / PAGE)) : 1;

  return (
    <div className="mx-auto max-w-6xl p-4 lg:p-8">
      <PageHeader title="Sales" subtitle="Invoices and held carts. Cashiers see only their own sales. Completed sales are never deleted; refund them from Returns." />
      <div className="mb-4 max-w-xs">
        <Select label="Status" value={status} onChange={(e) => (setStatus(e.target.value), setPage(1))}>
          <option value="">All</option>
          <option value="COMPLETED">Completed</option>
          <option value="HELD">Held (unpaid)</option>
          <option value="VOIDED">Voided</option>
        </Select>
      </div>
      <Card className="overflow-hidden">
        {q.isPending ? (
          <LoadingBlock />
        ) : q.isError ? (
          <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />
        ) : q.data.items.length === 0 ? (
          <EmptyState title="No sales yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Invoice</th>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Cashier</th>
                  <th className="px-4 py-3 text-right">Items</th>
                  <th className="px-4 py-3 text-right">Total</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {q.data.items.map((s) => (
                  <tr key={s.id} className="hover:bg-slate-50/60">
                    <td className="px-4 py-3 font-medium text-slate-900">{s.saleNumber}</td>
                    <td className="px-4 py-3 text-slate-600">{formatDateTime(s.createdAt)}</td>
                    <td className="px-4 py-3 text-slate-600">{s.cashier.fullName}</td>
                    <td className="num px-4 py-3 text-right">{s._count.items}</td>
                    <td className="num px-4 py-3 text-right font-semibold">{formatMoney(s.grandTotal)}</td>
                    <td className="px-4 py-3">
                      <Badge tone={s.status === "COMPLETED" ? "green" : s.status === "VOIDED" ? "red" : "amber"}>{s.status.toLowerCase()}</Badge>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button variant="ghost" size="sm" icon={<Printer className="size-4" />} onClick={() => setReceiptId(s.id)}>
                        Receipt
                      </Button>
                      {canVoid && s.status === "HELD" && (<Button variant="ghost" size="sm" data-testid={`void-${s.saleNumber}`} onClick={() => setVoiding({ id: s.id, saleNumber: s.saleNumber })}>Void</Button>)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {q.data && q.data.total > PAGE && (
          <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3 text-sm text-slate-600">
            <span>
              Page {page} of {pages}
            </span>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} icon={<ChevronLeft className="size-4" />}>
                Prev
              </Button>
              <Button variant="secondary" size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
                Next <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        )}
      </Card>
      <VoidModal sale={voiding} onClose={() => setVoiding(null)} />
      <ReceiptModal saleId={receiptId} onClose={() => setReceiptId(null)} title="Receipt" />
    </div>
  );
}

function VoidModal({ sale, onClose }: { sale: { id: string; saleNumber: string } | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState("");
  const m = useMutation({
    mutationFn: () => api.voidSale(sale!.id, reason.trim()),
    onSuccess: () => {
      toast.success(`${sale!.saleNumber} voided`);
      void qc.invalidateQueries({ queryKey: ["sales"] });
      setReason("");
      onClose();
    },
  });
  return (
    <Modal
      open={!!sale}
      title={`Void ${sale?.saleNumber ?? ""}`}
      onClose={onClose}
      locked={m.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={m.isPending}>
            Cancel
          </Button>
          <Button variant="danger" loading={m.isPending} disabled={reason.trim().length < 3} onClick={() => m.mutate()}>
            Void sale
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-slate-600">Only unpaid held carts can be voided. The void is recorded with your name and reason and cannot be undone.</p>
      <Textarea label="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
      {m.isError && (
        <div className="mt-3">
          <Alert>{errorMessage(m.error)}</Alert>
        </div>
      )}
    </Modal>
  );
}
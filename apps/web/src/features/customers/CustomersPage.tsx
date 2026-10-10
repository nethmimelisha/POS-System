import { useState, type FormEvent } from "react";
import { Pencil, Plus, Search, UserRound } from "lucide-react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import { errorMessage } from "@/api/client";
import type { Customer } from "@/api/types";
import { useAuth } from "@/auth/AuthProvider";
import { Alert, Badge, Card, EmptyState, ErrorState, LoadingBlock, PageHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Textarea } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Pager } from "@/components/ui/Pager";
import { useToast } from "@/components/ui/Toast";
import { formatDateTime, formatMoney } from "@/lib/format";

const PAGE = 20;

export function CustomersPage() {
  const { user } = useAuth();
  const isManager = user?.role !== "CASHIER";
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Customer | "new" | null>(null);
  const [historyOf, setHistoryOf] = useState<Customer | null>(null);
  const q = useQuery({ queryKey: ["customers", search, page], queryFn: () => api.customers({ search: search.trim() || undefined, page, pageSize: PAGE }), placeholderData: keepPreviousData });

  return (
    <div className="mx-auto max-w-5xl p-4 lg:p-8">
      <PageHeader
        title="Customers"
        subtitle="Optional. Walk-in sales never need a customer."
        actions={
          <Button icon={<Plus className="size-4" />} onClick={() => setEditing("new")}>
            New customer
          </Button>
        }
      />
      <div className="mb-4 max-w-md">
        <Input aria-label="Search customers" placeholder="Search by name, phone or email" leading={<Search className="size-4" />} value={search} onChange={(e) => (setSearch(e.target.value), setPage(1))} />
      </div>
      <Card className="overflow-hidden">
        {q.isPending ? (
          <LoadingBlock />
        ) : q.isError ? (
          <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />
        ) : q.data.items.length === 0 ? (
          <EmptyState title="No customers found" icon={<UserRound className="size-6" />} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm" data-testid="customers-table">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Phone</th>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {q.data.items.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50/60">
                    <td className="px-4 py-3 font-medium text-slate-900">{c.name}</td>
                    <td className="px-4 py-3 text-slate-600">{c.phone ?? "—"}</td>
                    <td className="px-4 py-3 text-slate-600">{c.email ?? "—"}</td>
                    <td className="px-4 py-3 text-right">
                      {isManager && (
                        <Button variant="ghost" size="sm" onClick={() => setHistoryOf(c)}>
                          Purchases
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" aria-label={`Edit ${c.name}`} icon={<Pencil className="size-4" />} onClick={() => setEditing(c)}>
                        Edit
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager page={page} total={q.data?.total ?? 0} pageSize={PAGE} onPage={setPage} />
      </Card>
      {editing && <CustomerForm customer={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {historyOf && <HistoryModal customer={historyOf} onClose={() => setHistoryOf(null)} />}
    </div>
  );
}

export function CustomerForm({ customer, onClose, onSaved }: { customer: Customer | null; onClose: () => void; onSaved?: (c: Customer) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(customer?.name ?? "");
  const [phone, setPhone] = useState(customer?.phone ?? "");
  const [email, setEmail] = useState(customer?.email ?? "");
  const [notes, setNotes] = useState(customer?.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const data = { name: name.trim(), phone: phone.trim() || null, email: email.trim() || null, notes: notes.trim() || null };
      return customer ? api.updateCustomer(customer.id, data) : api.createCustomer(data);
    },
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: ["customers"] });
      toast.success(customer ? "Customer updated" : "Customer created");
      onSaved?.(c);
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (name.trim()) save.mutate();
  };
  return (
    <Modal
      open
      size="sm"
      title={customer ? "Edit customer" : "New customer"}
      onClose={onClose}
      locked={save.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="customer-form" loading={save.isPending} disabled={!name.trim()}>
            Save customer
          </Button>
        </>
      }
    >
      <form id="customer-form" onSubmit={submit} className="space-y-3">
        {error && <Alert>{error}</Alert>}
        <Input label="Name" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        <Input label="Phone" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <Input label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Textarea label="Notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </form>
    </Modal>
  );
}

function HistoryModal({ customer, onClose }: { customer: Customer; onClose: () => void }) {
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ["customer-history", customer.id, page], queryFn: () => api.customerHistory(customer.id, page), placeholderData: keepPreviousData });
  return (
    <Modal open size="lg" title={`${customer.name} · purchase history`} onClose={onClose} footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      {q.isPending && <LoadingBlock />}
      {q.isError && <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />}
      {q.data && (
        <div className="space-y-4" data-testid="customer-history">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ["Purchases", String(q.data.summary.purchases)],
              ["Total spent", formatMoney(q.data.summary.totalSpent)],
              ["Refunded", formatMoney(q.data.summary.totalRefunded)],
              ["Net spent", formatMoney(q.data.summary.netSpent)],
            ].map(([l, v]) => (
              <div key={l} className="rounded-lg bg-slate-50 p-3">
                <p className="text-xs text-slate-500">{l}</p>
                <p className="num font-semibold text-navy-950">{v}</p>
              </div>
            ))}
          </div>
          {q.data.sales.length === 0 ? (
            <EmptyState title="No purchases yet" />
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="py-2">Invoice</th>
                  <th className="py-2">Date</th>
                  <th className="py-2 text-right">Total</th>
                  <th className="py-2">Returns</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {q.data.sales.map((s) => (
                  <tr key={s.id}>
                    <td className="py-2 font-medium">{s.saleNumber}</td>
                    <td className="py-2 text-slate-600">{formatDateTime(s.createdAt)}</td>
                    <td className="num py-2 text-right">{formatMoney(s.grandTotal)}</td>
                    <td className="py-2">
                      {s.returns.map((r) => (
                        <Badge key={r.returnNumber} tone="amber">
                          {r.returnNumber} · {formatMoney(r.refundTotal)}
                        </Badge>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <Pager page={page} total={q.data.total} pageSize={q.data.pageSize} onPage={setPage} />
        </div>
      )}
    </Modal>
  );
}

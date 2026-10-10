import { useState, type FormEvent } from "react";
import { ArrowDownCircle, ArrowUpCircle, Banknote, CheckCircle2, Lock, Play } from "lucide-react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import { errorMessage } from "@/api/client";
import type { Shift, ShiftSummary } from "@/api/types";
import { useAuth } from "@/auth/AuthProvider";
import { Alert, Badge, Card, EmptyState, ErrorState, LoadingBlock, PageHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Select, Textarea } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Pager } from "@/components/ui/Pager";
import { useToast } from "@/components/ui/Toast";
import { formatDateTime, formatMoney } from "@/lib/format";

const PAGE = 15;
const validAmount = (s: string) => s.trim() !== "" && Number.isFinite(Number(s)) && Number(s) >= 0 && Math.round(Number(s) * 100) / 100 === Number(s);

export function ShiftsPage() {
  const { user } = useAuth();
  const isManager = user?.role !== "CASHIER";
  const qc = useQueryClient();
  const mine = useQuery({ queryKey: ["shift", "mine"], queryFn: api.myShift, refetchInterval: 20_000 });
  const [page, setPage] = useState(1);
  const [onlyPending, setOnlyPending] = useState(false);
  const history = useQuery({
    queryKey: ["shifts", page, onlyPending],
    queryFn: () => api.shifts({ page, pageSize: PAGE, discrepancy: onlyPending ? "PENDING_APPROVAL" : undefined }),
    placeholderData: keepPreviousData,
  });
  const [detail, setDetail] = useState<number | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["shift"] });
    void qc.invalidateQueries({ queryKey: ["shifts"] });
  };

  return (
    <div className="mx-auto max-w-6xl p-4 lg:p-8">
      <PageHeader title="Shifts & cash drawer" subtitle="Open a shift before selling, track the drawer and reconcile at close." />

      {mine.isPending ? (
        <LoadingBlock />
      ) : mine.isError ? (
        <ErrorState message={errorMessage(mine.error)} onRetry={() => mine.refetch()} />
      ) : mine.data ? (
        <OpenShiftPanel shiftId={mine.data.id} onChanged={refresh} />
      ) : (
        <OpenShiftForm isManager={isManager} onOpened={refresh} />
      )}

      <div className="mb-3 mt-8 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-navy-950">Shift history</h2>
        {isManager && (
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" className="size-4 accent-navy-900" checked={onlyPending} onChange={(e) => (setOnlyPending(e.target.checked), setPage(1))} />
            Awaiting approval only
          </label>
        )}
      </div>
      <Card className="overflow-hidden">
        {history.isPending ? (
          <LoadingBlock />
        ) : history.isError ? (
          <ErrorState message={errorMessage(history.error)} onRetry={() => history.refetch()} />
        ) : history.data.items.length === 0 ? (
          <EmptyState title="No shifts yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm" data-testid="shift-history">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Register</th>
                  <th className="px-4 py-3">Cashier</th>
                  <th className="px-4 py-3">Opened</th>
                  <th className="px-4 py-3 text-right">Expected</th>
                  <th className="px-4 py-3 text-right">Counted</th>
                  <th className="px-4 py-3 text-right">Variance</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {history.data.items.map((s) => (
                  <tr key={s.id} className="hover:bg-slate-50/60">
                    <td className="px-4 py-3 font-medium">{s.register.name}</td>
                    <td className="px-4 py-3 text-slate-600">{s.cashier.fullName}</td>
                    <td className="px-4 py-3 text-slate-600">{formatDateTime(s.openedAt)}</td>
                    <td className="num px-4 py-3 text-right">{s.expectedCash ? formatMoney(s.expectedCash) : "—"}</td>
                    <td className="num px-4 py-3 text-right">{s.countedCash ? formatMoney(s.countedCash) : "—"}</td>
                    <td className="num px-4 py-3 text-right">{s.variance ? formatMoney(s.variance) : "—"}</td>
                    <td className="px-4 py-3">
                      <StatusBadge shift={s} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button variant="ghost" size="sm" onClick={() => setDetail(s.id)}>
                        Details
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager page={page} total={history.data?.total ?? 0} pageSize={PAGE} onPage={setPage} />
      </Card>
      {detail !== null && <ShiftDetail id={detail} canApprove={isManager} userId={user!.id} onClose={() => setDetail(null)} onChanged={refresh} />}
    </div>
  );
}

function StatusBadge({ shift }: { shift: Shift }) {
  if (shift.status === "OPEN") return <Badge tone="green">Open</Badge>;
  if (shift.discrepancy === "PENDING_APPROVAL") return <Badge tone="amber">Needs approval</Badge>;
  if (shift.discrepancy === "APPROVED") return <Badge tone="navy">Approved</Badge>;
  return <Badge>Balanced</Badge>;
}

function OpenShiftForm({ isManager, onOpened }: { isManager: boolean; onOpened: () => void }) {
  const toast = useToast();
  const registers = useQuery({ queryKey: ["registers"], queryFn: api.registers, staleTime: Infinity });
  const users = useQuery({ queryKey: ["users"], queryFn: api.users, enabled: isManager });
  const [registerId, setRegisterId] = useState(() => localStorage.getItem("pos.register") ?? "");
  const [cashierId, setCashierId] = useState("");
  const [cash, setCash] = useState("");
  const [error, setError] = useState<string | null>(null);
  const reg = registerId || String(registers.data?.[0]?.id ?? "");

  const open = useMutation({
    mutationFn: () => api.openShift({ registerId: Number(reg), openingCash: Number(cash), ...(cashierId ? { cashierId } : {}) }),
    onSuccess: () => {
      toast.success("Shift opened");
      localStorage.setItem("pos.register", reg);
      onOpened();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (validAmount(cash) && reg) open.mutate();
  };

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center gap-3">
        <span className="grid size-10 place-items-center rounded-lg bg-navy-50 text-navy-700">
          <Play className="size-5" />
        </span>
        <div>
          <h2 className="font-semibold text-navy-950">No open shift</h2>
          <p className="text-sm text-slate-500">Count the drawer and enter the opening cash to start.</p>
        </div>
      </div>
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-3" data-testid="open-shift-form">
        {error && (
          <div className="sm:col-span-3">
            <Alert>{error}</Alert>
          </div>
        )}
        <Select label="Register" value={reg} onChange={(e) => setRegisterId(e.target.value)}>
          {registers.data?.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </Select>
        <Input label="Opening cash (Rs.)" inputMode="decimal" value={cash} onChange={(e) => setCash(e.target.value)} error={cash !== "" && !validAmount(cash) ? "Enter a valid amount" : undefined} />
        {isManager ? (
          <Select label="Cashier" value={cashierId} onChange={(e) => setCashierId(e.target.value)}>
            <option value="">Me</option>
            {users.data?.filter((u) => u.isActive && u.role === "CASHIER").map((u) => (
              <option key={u.id} value={u.id}>
                {u.fullName}
              </option>
            ))}
          </Select>
        ) : (
          <div />
        )}
        <div className="sm:col-span-3">
          <Button type="submit" loading={open.isPending} disabled={!validAmount(cash) || !reg}>
            Open shift
          </Button>
        </div>
      </form>
    </Card>
  );
}

function Row({ label, value, strong, tone }: { label: string; value: string; strong?: boolean; tone?: "red" | "green" }) {
  return (
    <div className={`flex justify-between py-1.5 text-sm ${strong ? "border-t border-slate-200 pt-2 font-semibold text-navy-950" : "text-slate-600"}`}>
      <span>{label}</span>
      <span className={`num ${tone === "red" ? "text-red-600" : tone === "green" ? "text-emerald-600" : ""}`}>{value}</span>
    </div>
  );
}

export function DrawerSummary({ s }: { s: ShiftSummary }) {
  return (
    <div data-testid="drawer-summary">
      <Row label="Opening cash" value={formatMoney(s.openingCash)} />
      <Row label="Cash received on sales" value={formatMoney(s.cashSales)} />
      <Row label="Change given" value={`-${formatMoney(s.changeGiven)}`} />
      <Row label="Cash in" value={formatMoney(s.cashIn)} tone="green" />
      <Row label="Cash out" value={`-${formatMoney(s.cashOut)}`} tone="red" />
      <Row label="Cash refunds" value={`-${formatMoney(s.cashRefunds)}`} tone="red" />
      <Row label="Expected in drawer" value={formatMoney(s.expectedCash)} strong />
      {(s.nonCashSales.length > 0 || s.nonCashRefunds.length > 0) && (
        <div className="mt-3 rounded-lg bg-slate-50 p-3 text-xs text-slate-500">
          <p className="mb-1 font-medium text-slate-600">Not in the drawer</p>
          {s.nonCashSales.map((n) => (
            <div key={n.method} className="flex justify-between">
              <span>{n.method} sales</span>
              <span className="num">{formatMoney(n.amount)}</span>
            </div>
          ))}
          {s.nonCashRefunds.map((n, i) => (
            <div key={i} className="flex justify-between">
              <span>
                {n.method} refunds ({n.status.toLowerCase()})
              </span>
              <span className="num">{formatMoney(n.amount)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function OpenShiftPanel({ shiftId, onChanged }: { shiftId: number; onChanged: () => void }) {
  const q = useQuery({ queryKey: ["shift", shiftId], queryFn: () => api.shift(shiftId), refetchInterval: 15_000 });
  const [movement, setMovement] = useState<"CASH_IN" | "CASH_OUT" | null>(null);
  const [closing, setClosing] = useState(false);
  if (q.isPending) return <LoadingBlock />;
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />;
  const s = q.data;

  return (
    <div className="grid gap-6 lg:grid-cols-5" data-testid="open-shift">
      <Card className="p-5 lg:col-span-3">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="flex items-center gap-2 font-semibold text-navy-950">
              <Banknote className="size-5 text-navy-700" /> {s.register.name}
              <Badge tone="green">Open</Badge>
            </h2>
            <p className="text-sm text-slate-500">
              {s.cashier.fullName} · since {formatDateTime(s.openedAt)} · {s.summary?.salesCount ?? 0} sales
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" icon={<ArrowDownCircle className="size-4" />} onClick={() => setMovement("CASH_IN")}>
              Cash in
            </Button>
            <Button variant="secondary" size="sm" icon={<ArrowUpCircle className="size-4" />} onClick={() => setMovement("CASH_OUT")}>
              Cash out
            </Button>
            <Button size="sm" icon={<Lock className="size-4" />} onClick={() => setClosing(true)}>
              Close shift
            </Button>
          </div>
        </div>
        {s.summary && <DrawerSummary s={s.summary} />}
      </Card>
      <Card className="p-5 lg:col-span-2">
        <h3 className="mb-3 font-semibold text-navy-950">Cash adjustments</h3>
        {s.movements && s.movements.length > 0 ? (
          <ul className="divide-y divide-slate-100 text-sm">
            {s.movements.map((m) => (
              <li key={m.id} className="py-2">
                <div className="flex justify-between">
                  <span className="font-medium">{m.type === "CASH_IN" ? "Cash in" : "Cash out"}</span>
                  <span className={`num ${m.type === "CASH_IN" ? "text-emerald-600" : "text-red-600"}`}>
                    {m.type === "CASH_IN" ? "+" : "-"}
                    {formatMoney(m.amount)}
                  </span>
                </div>
                <p className="text-xs text-slate-500">
                  {m.reason} · {m.createdBy.fullName}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-400">No adjustments yet.</p>
        )}
      </Card>
      {movement && <MovementModal shiftId={s.id} type={movement} onClose={() => setMovement(null)} onDone={onChanged} />}
      {closing && <CloseModal shift={s} onClose={() => setClosing(false)} onDone={onChanged} />}
    </div>
  );
}

function MovementModal({ shiftId, type, onClose, onDone }: { shiftId: number; type: "CASH_IN" | "CASH_OUT"; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => api.cashMovement(shiftId, { type, amount: Number(amount), reason: reason.trim() }),
    onSuccess: () => {
      toast.success(type === "CASH_IN" ? "Cash in recorded" : "Cash out recorded");
      onDone();
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const valid = validAmount(amount) && Number(amount) > 0 && reason.trim().length >= 3;
  return (
    <Modal
      open
      size="sm"
      title={type === "CASH_IN" ? "Cash in" : "Cash out"}
      onClose={onClose}
      locked={m.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={m.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="movement-form" loading={m.isPending} disabled={!valid}>
            Record
          </Button>
        </>
      }
    >
      <form
        id="movement-form"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          if (valid) m.mutate();
        }}
      >
        {error && <Alert>{error}</Alert>}
        <Input label="Amount (Rs.)" inputMode="decimal" autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} />
        <Input label="Reason" placeholder={type === "CASH_IN" ? "e.g. Float top-up" : "e.g. Supplier payment"} value={reason} onChange={(e) => setReason(e.target.value)} />
      </form>
    </Modal>
  );
}

function CloseModal({ shift, onClose, onDone }: { shift: Shift; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [counted, setCounted] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Shift | null>(null);
  const expected = Number(shift.summary?.expectedCash ?? 0);
  const variance = validAmount(counted) ? Math.round((Number(counted) - expected) * 100) / 100 : null;
  const needsNotes = variance !== null && variance !== 0;

  const m = useMutation({
    mutationFn: () => api.closeShift(shift.id, { countedCash: Number(counted), ...(notes.trim() ? { notes: notes.trim() } : {}) }),
    onSuccess: (s) => {
      toast.success("Shift closed");
      setResult(s);
    },
    onError: (e) => setError(errorMessage(e)),
  });

  if (result) {
    const v = Number(result.variance ?? 0);
    // Refresh the page state only once this summary is dismissed, because the open-shift panel hosting it unmounts.
    const finish = () => {
      onDone();
      onClose();
    };
    return (
      <Modal open size="sm" title="Shift closed" onClose={finish} footer={<Button onClick={finish}>Done</Button>}>
        <div data-testid="close-result" className="space-y-1">
          <Row label="Expected cash" value={formatMoney(result.expectedCash ?? 0)} />
          <Row label="Counted cash" value={formatMoney(result.countedCash ?? 0)} />
          <Row label={v < 0 ? "Shortage" : v > 0 ? "Overage" : "Variance"} value={formatMoney(v)} strong tone={v < 0 ? "red" : v > 0 ? "green" : undefined} />
          {v !== 0 && <Alert tone="amber">A manager must review and approve this discrepancy.</Alert>}
          {v === 0 && (
            <Alert tone="green">
              <CheckCircle2 className="mr-1 inline size-4" />
              The drawer balances.
            </Alert>
          )}
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open
      size="sm"
      title="Close shift"
      onClose={onClose}
      locked={m.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={m.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="close-form" loading={m.isPending} disabled={!validAmount(counted) || (needsNotes && !notes.trim())}>
            Close shift
          </Button>
        </>
      }
    >
      <form
        id="close-form"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          if (validAmount(counted) && !(needsNotes && !notes.trim())) m.mutate();
        }}
      >
        {error && <Alert>{error}</Alert>}
        <p className="text-sm text-slate-600">
          Expected in drawer: <strong className="num">{formatMoney(expected)}</strong>. Count the cash and enter the total.
        </p>
        <Input label="Counted cash (Rs.)" inputMode="decimal" autoFocus value={counted} onChange={(e) => setCounted(e.target.value)} />
        {variance !== null && variance !== 0 && (
          <Alert tone="amber">
            {variance < 0 ? "Shortage" : "Overage"} of {formatMoney(Math.abs(variance))}. Add a note explaining the difference.
          </Alert>
        )}
        <Textarea label={needsNotes ? "Notes (required)" : "Notes"} value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
      </form>
    </Modal>
  );
}

function ShiftDetail({ id, canApprove, userId, onClose, onChanged }: { id: number; canApprove: boolean; userId: string; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const q = useQuery({ queryKey: ["shift", id], queryFn: () => api.shift(id) });
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const approve = useMutation({
    mutationFn: () => api.approveShift(id, note.trim()),
    onSuccess: () => {
      toast.success("Discrepancy approved");
      onChanged();
      void q.refetch();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const s = q.data;
  return (
    <Modal open size="md" title={s ? `${s.register.name} · ${formatDateTime(s.openedAt)}` : "Shift"} onClose={onClose} footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      {q.isPending && <LoadingBlock />}
      {q.isError && <ErrorState message={errorMessage(q.error)} />}
      {s && (
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            {s.cashier.fullName} · <StatusBadge shift={s} />
          </p>
          {s.summary && <DrawerSummary s={s.summary} />}
          {s.status === "CLOSED" && (
            <div className="rounded-lg border border-slate-200 p-3">
              <Row label="Counted cash" value={formatMoney(s.countedCash ?? 0)} />
              <Row label="Variance" value={formatMoney(s.variance ?? 0)} strong tone={Number(s.variance) < 0 ? "red" : Number(s.variance) > 0 ? "green" : undefined} />
              {s.closingNotes && <p className="mt-2 text-sm text-slate-600">Cashier note: {s.closingNotes}</p>}
              {s.discrepancy === "APPROVED" && (
                <p className="mt-2 text-sm text-slate-600">
                  Approved by {s.approvedBy?.fullName}: {s.approvalNote}
                </p>
              )}
            </div>
          )}
          {s.discrepancy === "PENDING_APPROVAL" && canApprove &&
            (s.cashierId === userId ? (
              <Alert tone="amber">A different manager or admin must approve your own shift.</Alert>
            ) : (
              <div className="space-y-2">
                {error && <Alert>{error}</Alert>}
                <Input label="Approval note" value={note} onChange={(e) => setNote(e.target.value)} />
                <Button loading={approve.isPending} disabled={note.trim().length < 3} onClick={() => (setError(null), approve.mutate())}>
                  Approve discrepancy
                </Button>
              </div>
            ))}
        </div>
      )}
    </Modal>
  );
}

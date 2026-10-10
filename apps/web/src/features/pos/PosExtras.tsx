import { useState } from "react";
import { Link } from "react-router-dom";
import { Landmark, UserRound, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api";
import { useCart } from "@/cart/CartContext";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { CustomerForm } from "@/features/customers/CustomersPage";

export function ShiftBanner() {
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const shift = useQuery({ queryKey: ["shift", "mine"], queryFn: api.myShift, staleTime: 30_000 });
  if (shift.isPending || settings.isPending || shift.isError) return null;
  if (shift.data) return null;
  const required = settings.data?.requireShift;
  return (
    <div
      role={required ? "alert" : "status"}
      data-testid="shift-banner"
      className={`mb-3 flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm ${required ? "border-amber-300 bg-amber-50 text-amber-900" : "border-slate-200 bg-slate-50 text-slate-600"}`}
    >
      <span className="flex items-center gap-2">
        <Landmark className="size-4" />
        {required ? "A shift must be open on the register before sales can be completed." : "No open shift. Sales are not linked to a cash drawer."}
      </span>
      <Link to="/shifts" className="font-medium text-navy-700 hover:underline">
        Open shift
      </Link>
    </div>
  );
}

export function CustomerPicker({ disabled }: { disabled?: boolean }) {
  const { cart, dispatch } = useCart();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");
  const q = useQuery({ queryKey: ["customers", "picker", search], queryFn: () => api.customers({ search: search.trim() || undefined, pageSize: 8 }), enabled: open });

  return (
    <div className="border-b border-slate-200 px-4 py-2" data-testid="customer-picker">
      {cart.customer ? (
        <div className="flex items-center justify-between text-sm">
          <span className="flex items-center gap-2 font-medium text-navy-900">
            <UserRound className="size-4" /> {cart.customer.name}
          </span>
          <button disabled={disabled} aria-label="Remove customer" onClick={() => dispatch({ type: "customer" })} className="grid size-7 place-items-center rounded text-slate-400 hover:bg-slate-100 disabled:opacity-40">
            <X className="size-4" />
          </button>
        </div>
      ) : (
        <button disabled={disabled} onClick={() => setOpen(true)} className="flex items-center gap-2 text-sm text-slate-500 hover:text-navy-700 disabled:opacity-40">
          <UserRound className="size-4" /> Walk-in customer · <span className="font-medium text-navy-700">Add customer</span>
        </button>
      )}
      <Modal open={open} size="sm" title="Attach customer" onClose={() => setOpen(false)} footer={<Button variant="secondary" onClick={() => (setOpen(false), setCreating(true))}>New customer</Button>}>
        <Input aria-label="Find customer" autoFocus placeholder="Name, phone or email" value={search} onChange={(e) => setSearch(e.target.value)} />
        <ul className="mt-3 divide-y divide-slate-100">
          {q.data?.items.map((c) => (
            <li key={c.id}>
              <button
                className="w-full px-1 py-2.5 text-left text-sm hover:bg-slate-50"
                onClick={() => {
                  dispatch({ type: "customer", customer: { id: c.id, name: c.name } });
                  setOpen(false);
                }}
              >
                <span className="font-medium">{c.name}</span> <span className="text-slate-500">{c.phone ?? c.email ?? ""}</span>
              </button>
            </li>
          ))}
          {q.data?.items.length === 0 && <li className="py-3 text-sm text-slate-500">No matching customers.</li>}
        </ul>
      </Modal>
      {creating && <CustomerForm customer={null} onClose={() => setCreating(false)} onSaved={(c) => dispatch({ type: "customer", customer: { id: c.id, name: c.name } })} />}
    </div>
  );
}

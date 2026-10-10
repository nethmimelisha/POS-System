import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import { errorMessage } from "@/api/client";
import type { ManagedUser, Role, Settings } from "@/api/types";
import { useAuth } from "@/auth/AuthProvider";
import { roleLabel } from "@/auth/nav";
import { Alert, Badge, Card, ErrorState, LoadingBlock, PageHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Checkbox, Input, Select, Textarea } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { formatDateTime } from "@/lib/format";

type Tab = "account" | "business" | "users";

export function SettingsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "ADMIN";
  const tabs: { id: Tab; label: string }[] = [
    { id: "account", label: "My account" },
    { id: "business", label: "Business" },
    ...(isAdmin ? [{ id: "users" as const, label: "Users" }] : []),
  ];
  const [tab, setTab] = useState<Tab>("account");

  return (
    <div className="mx-auto max-w-4xl p-4 lg:p-8">
      <PageHeader title="Settings" />
      <div className="mb-5 inline-flex rounded-lg bg-slate-100 p-1" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={`h-9 rounded-md px-4 text-sm font-medium ${tab === t.id ? "bg-white text-navy-900 shadow-sm" : "text-slate-500"}`}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === "account" && <AccountTab />}
      {tab === "business" && <BusinessTab canEdit={isAdmin} />}
      {tab === "users" && isAdmin && <UsersTab />}
    </div>
  );
}

function AccountTab() {
  const { user } = useAuth();
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const mismatch = confirm !== "" && confirm !== next;
  const valid = current !== "" && next.length >= 8 && next === confirm;

  const m = useMutation({
    mutationFn: () => api.changePassword(current, next),
    onSuccess: () => {
      toast.success("Password changed");
      setCurrent("");
      setNext("");
      setConfirm("");
    },
    onError: (e) => setError(errorMessage(e)),
  });

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Card className="p-5">
        <h2 className="mb-3 font-semibold text-navy-950">Profile</h2>
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between"><dt className="text-slate-500">Name</dt><dd>{user?.fullName}</dd></div>
          <div className="flex justify-between"><dt className="text-slate-500">Username</dt><dd>{user?.username}</dd></div>
          <div className="flex justify-between"><dt className="text-slate-500">Role</dt><dd>{user && roleLabel[user.role]}</dd></div>
        </dl>
      </Card>
      <Card className="p-5">
        <h2 className="mb-3 font-semibold text-navy-950">Change password</h2>
        <form
          className="space-y-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            setError(null);
            if (valid) m.mutate();
          }}
        >
          {error && <Alert>{error}</Alert>}
          <Input label="Current password" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          <Input label="New password" type="password" autoComplete="new-password" hint="At least 8 characters" value={next} onChange={(e) => setNext(e.target.value)} />
          <Input label="Confirm new password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} error={mismatch ? "Passwords do not match" : undefined} />
          <Button type="submit" loading={m.isPending} disabled={!valid}>
            Update password
          </Button>
        </form>
      </Card>
    </div>
  );
}

function BusinessTab({ canEdit }: { canEdit: boolean }) {
  const q = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  if (q.isPending) return <LoadingBlock />;
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />;
  return <BusinessForm settings={q.data} canEdit={canEdit} />;
}

function BusinessForm({ settings, canEdit }: { settings: Settings; canEdit: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState(settings);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setF((s) => ({ ...s, [k]: v }));
  const nullable = (s: string) => (s.trim() === "" ? null : s);

  const m = useMutation({
    mutationFn: () =>
      api.updateSettings({
        name: f.name.trim(),
        address: f.address,
        phone: f.phone,
        vatNumber: f.vatNumber,
        taxEnabled: f.taxEnabled,
        pricesIncludeTax: f.pricesIncludeTax,
        allowNegativeStock: f.allowNegativeStock,
        requireShift: f.requireShift,
        timezone: f.timezone.trim(),
        receiptHeader: f.receiptHeader,
        receiptFooter: f.receiptFooter,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["settings"] });
      void qc.invalidateQueries({ queryKey: ["receipt"] });
      toast.success("Settings saved");
    },
    onError: (e) => setError(errorMessage(e)),
  });

  return (
    <Card className="p-5">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          m.mutate();
        }}
      >
        {!canEdit && <Alert tone="navy">Only administrators can change business settings.</Alert>}
        {error && <Alert>{error}</Alert>}
        <fieldset disabled={!canEdit || m.isPending} className="grid gap-4 sm:grid-cols-2">
          <Input wrapperClassName="sm:col-span-2" label="Business name" value={f.name} onChange={(e) => set("name", e.target.value)} />
          <Input label="Phone" value={f.phone ?? ""} onChange={(e) => set("phone", nullable(e.target.value))} />
          <Input label="VAT registration no." value={f.vatNumber ?? ""} onChange={(e) => set("vatNumber", nullable(e.target.value))} />
          <Input wrapperClassName="sm:col-span-2" label="Address" value={f.address ?? ""} onChange={(e) => set("address", nullable(e.target.value))} />
          <Textarea label="Receipt header" value={f.receiptHeader ?? ""} onChange={(e) => set("receiptHeader", nullable(e.target.value))} />
          <Textarea label="Receipt footer" value={f.receiptFooter ?? ""} onChange={(e) => set("receiptFooter", nullable(e.target.value))} />
          <Input wrapperClassName="sm:col-span-2" label="Store timezone" hint="IANA name, used to group reports by day (e.g. Asia/Colombo)" value={f.timezone} onChange={(e) => set("timezone", e.target.value)} />
          <div className="space-y-3 sm:col-span-2">
            <Checkbox label="Require an open shift to sell" hint="When on, sales are blocked on a register until a shift is opened" checked={f.requireShift} onChange={(e) => set("requireShift", e.target.checked)} />
            <Checkbox label="Charge VAT" hint="Leave off until your VAT registration and tax treatment are confirmed" checked={f.taxEnabled} onChange={(e) => set("taxEnabled", e.target.checked)} />
            <Checkbox label="Prices include VAT" checked={f.pricesIncludeTax} onChange={(e) => set("pricesIncludeTax", e.target.checked)} />
            <Checkbox label="Allow selling below zero stock" checked={f.allowNegativeStock} onChange={(e) => set("allowNegativeStock", e.target.checked)} />
          </div>
        </fieldset>
        {canEdit && (
          <Button type="submit" loading={m.isPending} disabled={!f.name.trim()}>
            Save settings
          </Button>
        )}
      </form>
    </Card>
  );
}

function UsersTab() {
  const q = useQuery({ queryKey: ["users"], queryFn: api.users });
  const [editing, setEditing] = useState<ManagedUser | "new" | null>(null);
  if (q.isPending) return <LoadingBlock />;
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />;
  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button onClick={() => setEditing("new")}>New user</Button>
      </div>
      <Card className="overflow-hidden">
        <table className="w-full text-left text-sm" data-testid="users-table">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">User</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">Last login</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {q.data.map((u) => (
              <tr key={u.id}>
                <td className="px-4 py-3">
                  <p className="font-medium text-slate-900">{u.fullName}</p>
                  <p className="text-xs text-slate-500">{u.username}</p>
                </td>
                <td className="px-4 py-3">{roleLabel[u.role]}</td>
                <td className="px-4 py-3 text-slate-600">{u.lastLoginAt ? formatDateTime(u.lastLoginAt) : "Never"}</td>
                <td className="px-4 py-3">
                  <Badge tone={u.isActive ? "green" : "slate"}>{u.isActive ? "active" : "disabled"}</Badge>
                </td>
                <td className="px-4 py-3 text-right">
                  <Button variant="ghost" size="sm" onClick={() => setEditing(u)}>
                    Edit
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {editing && <UserForm user={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function UserForm({ user, onClose }: { user: ManagedUser | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [username, setUsername] = useState(user?.username ?? "");
  const [fullName, setFullName] = useState(user?.fullName ?? "");
  const [role, setRole] = useState<Role>(user?.role ?? "CASHIER");
  const [password, setPassword] = useState("");
  const [isActive, setIsActive] = useState(user?.isActive ?? true);
  const [error, setError] = useState<string | null>(null);

  const m = useMutation({
    mutationFn: () =>
      user
        ? api.updateUser(user.id, { fullName: fullName.trim(), role, isActive, ...(password ? { password } : {}) })
        : api.createUser({ username: username.trim(), fullName: fullName.trim(), role, password }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["users"] });
      toast.success(user ? "User updated" : "User created");
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const valid = fullName.trim() && (user ? password === "" || password.length >= 8 : username.trim().length >= 3 && password.length >= 8);

  return (
    <Modal
      open
      size="sm"
      title={user ? "Edit user" : "New user"}
      onClose={onClose}
      locked={m.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={m.isPending}>
            Cancel
          </Button>
          <Button loading={m.isPending} disabled={!valid} onClick={() => (setError(null), m.mutate())}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error && <Alert>{error}</Alert>}
        <Input label="Username" value={username} disabled={!!user} onChange={(e) => setUsername(e.target.value)} />
        <Input label="Full name" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        <Select label="Role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
          {(Object.keys(roleLabel) as Role[]).map((r) => (
            <option key={r} value={r}>
              {roleLabel[r]}
            </option>
          ))}
        </Select>
        <Input label={user ? "New password (optional)" : "Password"} type="password" autoComplete="new-password" hint="At least 8 characters" value={password} onChange={(e) => setPassword(e.target.value)} />
        {user && <Checkbox label="Active" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />}
      </div>
    </Modal>
  );
}

import { useState, type FormEvent } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { Lock, ShoppingBag, User as UserIcon } from "lucide-react";
import { useAuth } from "@/auth/AuthProvider";
import { homeFor } from "@/auth/ProtectedRoute";
import { ApiError, errorMessage } from "@/api/client";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Alert } from "@/components/ui/Card";

export function LoginPage() {
  const { user, login, sessionExpired } = useAuth();
  const location = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) {
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from && from !== "/login" ? from : homeFor(user.role)} replace />;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(username.trim(), password);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 429 ? "Too many attempts. Please wait a few minutes." : errorMessage(err));
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-full lg:grid-cols-2">
      <div className="relative hidden flex-col justify-between overflow-hidden bg-navy-900 p-12 text-white lg:flex">
        <div className="absolute -right-24 -top-24 size-96 rounded-full bg-white/5" />
        <div className="absolute -bottom-32 -left-16 size-[28rem] rounded-full bg-white/5" />
        <div className="relative flex items-center gap-3 text-lg font-semibold">
          <span className="grid size-10 place-items-center rounded-xl bg-white/10">
            <ShoppingBag className="size-5" />
          </span>
          Retail POS
        </div>
        <div className="relative max-w-md">
          <h2 className="text-3xl font-semibold leading-tight">Fast, accurate checkout for your store.</h2>
          <p className="mt-3 text-navy-200">Scan, charge and print in seconds, with stock and sales always in sync.</p>
        </div>
        <p className="relative text-sm text-navy-300">Amounts in LKR</p>
      </div>

      <div className="flex items-center justify-center p-6">
        <form onSubmit={submit} className="w-full max-w-sm" aria-label="Sign in">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <span className="grid size-10 place-items-center rounded-xl bg-navy-900 text-white">
              <ShoppingBag className="size-5" />
            </span>
            <span className="text-lg font-semibold text-navy-950">Retail POS</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-navy-950">Welcome back</h1>
          <p className="mb-6 mt-1 text-sm text-slate-500">Sign in to start your shift.</p>

          <div className="space-y-4">
            {sessionExpired && !error && <Alert tone="amber">Your session expired. Sign in again; your cart has been kept.</Alert>}
            {error && <Alert>{error}</Alert>}
            <Input label="Username" autoComplete="username" autoFocus required value={username} onChange={(e) => setUsername(e.target.value)} leading={<UserIcon className="size-4" />} />
            <Input
              label="Password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              leading={<Lock className="size-4" />}
            />
            <Button type="submit" size="lg" className="w-full" loading={busy} disabled={!username || !password}>
              Sign in
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

import { NavLink, Outlet } from "react-router-dom";
import { LogOut, ShoppingBag } from "lucide-react";
import { useAuth } from "@/auth/AuthProvider";
import { NAV_ITEMS, roleLabel } from "@/auth/nav";
import { useToast } from "@/components/ui/Toast";
import { errorMessage } from "@/api/client";

export function AppLayout() {
  const { user, logout } = useAuth();
  const toast = useToast();
  if (!user) return null;
  const items = NAV_ITEMS.filter((i) => i.roles.includes(user.role));

  const signOut = () => logout().catch((e) => toast.error(errorMessage(e)));

  return (
    <div className="flex h-full flex-col md:flex-row">
      <aside className="hidden shrink-0 flex-col bg-navy-900 text-navy-100 md:flex md:w-[72px] lg:w-60">
        <div className="flex h-16 items-center gap-3 border-b border-white/10 px-4 lg:px-5">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-white/10 text-white">
            <ShoppingBag className="size-5" />
          </span>
          <span className="hidden text-base font-semibold tracking-tight text-white lg:block">Retail POS</span>
        </div>
        <nav className="flex-1 space-y-1 p-3" aria-label="Main">
          {items.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              title={label}
              className={({ isActive }) =>
                `flex h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors ${
                  isActive ? "bg-white text-navy-900 shadow-sm" : "text-navy-200 hover:bg-white/10 hover:text-white"
                } justify-center lg:justify-start`
              }
            >
              <Icon className="size-5 shrink-0" />
              <span className="hidden lg:inline">{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-white/10 p-3">
          <div className="mb-2 hidden px-2 lg:block">
            <p className="truncate text-sm font-medium text-white" data-testid="current-user">
              {user.fullName}
            </p>
            <p className="text-xs text-navy-300">{roleLabel[user.role]}</p>
          </div>
          <button
            onClick={signOut}
            title="Sign out"
            className="flex h-10 w-full items-center justify-center gap-2 rounded-lg text-sm text-navy-200 hover:bg-white/10 hover:text-white lg:justify-start lg:px-3"
          >
            <LogOut className="size-5" />
            <span className="hidden lg:inline">Sign out</span>
          </button>
        </div>
      </aside>

      <main className="min-h-0 flex-1 overflow-y-auto" id="main">
        <Outlet />
      </main>

      <nav className="flex shrink-0 justify-around border-t border-slate-200 bg-white md:hidden" aria-label="Main (compact)">
        {items.map(({ to, label, icon: Icon }) => (
          <NavLink key={to} to={to} className={({ isActive }) => `flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] ${isActive ? "text-navy-900" : "text-slate-500"}`}>
            <Icon className="size-5" />
            {label}
          </NavLink>
        ))}
        <button onClick={signOut} className="flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] text-slate-500">
          <LogOut className="size-5" />
          Sign out
        </button>
      </nav>
    </div>
  );
}

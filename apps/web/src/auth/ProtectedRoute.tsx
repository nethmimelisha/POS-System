import { Navigate, Outlet, useLocation } from "react-router-dom";
import type { Role } from "@/api/types";
import { Spinner } from "@/components/ui/Spinner";
import { useAuth } from "./AuthProvider";

export const homeFor = (role: Role) => (role === "CASHIER" ? "/pos" : "/dashboard");

/** Everything inside requires a signed-in user. */
export function ProtectedRoute() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) {
    return (
      <div className="grid h-full place-items-center">
        <Spinner className="size-8 text-navy-700" />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}

/** The API enforces permissions; this only keeps people out of screens they cannot use. */
export function RoleRoute({ roles }: { roles: Role[] }) {
  const { user } = useAuth();
  if (!user) return null;
  if (!roles.includes(user.role)) return <Navigate to={homeFor(user.role)} replace />;
  return <Outlet />;
}

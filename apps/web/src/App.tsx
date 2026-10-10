import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { ApiError } from "@/api/client";
import { AuthProvider, useAuth } from "@/auth/AuthProvider";
import { ALL_ROLES, MANAGER_ROLES } from "@/auth/nav";
import { ProtectedRoute, RoleRoute, homeFor } from "@/auth/ProtectedRoute";
import { CartProvider } from "@/cart/CartContext";
import { AppLayout } from "@/components/layout/AppLayout";
import { ToastProvider } from "@/components/ui/Toast";
import { LoginPage } from "@/features/auth/LoginPage";
import { DashboardPage } from "@/features/dashboard/DashboardPage";
import { InventoryPage } from "@/features/inventory/InventoryPage";
import { PosPage } from "@/features/pos/PosPage";
import { ProductsPage } from "@/features/products/ProductsPage";
import { CustomersPage } from "@/features/customers/CustomersPage";
import { ReportsPage } from "@/features/reports/ReportsPage";
import { ReturnsPage } from "@/features/returns/ReturnsPage";
import { ExchangesPage } from "@/features/exchanges/ExchangesPage";
import { ShiftsPage } from "@/features/shifts/ShiftsPage";
import { SalesPage } from "@/features/sales/SalesPage";
import { SettingsPage } from "@/features/settings/SettingsPage";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: false,
      // Do not retry client errors (validation, auth, permissions); only transient failures.
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
    },
  },
});

function Home() {
  const { user } = useAuth();
  return <Navigate to={user ? homeFor(user.role) : "/login"} replace />;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ToastProvider>
          <AuthProvider>
            <CartProvider>
              <Routes>
                <Route path="/login" element={<LoginPage />} />
                <Route element={<ProtectedRoute />}>
                  <Route element={<AppLayout />}>
                    <Route index element={<Home />} />
                    <Route element={<RoleRoute roles={ALL_ROLES} />}>
                      <Route path="/pos" element={<PosPage />} />
                      <Route path="/dashboard" element={<DashboardPage />} />
                      <Route path="/sales" element={<SalesPage />} />
                      <Route path="/shifts" element={<ShiftsPage />} />
                      <Route path="/customers" element={<CustomersPage />} />
                      <Route path="/settings" element={<SettingsPage />} />
                    </Route>
                    <Route element={<RoleRoute roles={MANAGER_ROLES} />}>
                      <Route path="/returns" element={<ReturnsPage />} />
                      <Route path="/exchanges" element={<ExchangesPage />} />
                      <Route path="/reports" element={<ReportsPage />} />
                      <Route path="/products" element={<ProductsPage />} />
                      <Route path="/inventory" element={<InventoryPage />} />
                    </Route>
                    <Route path="*" element={<Home />} />
                  </Route>
                </Route>
              </Routes>
            </CartProvider>
          </AuthProvider>
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

import { BarChart3, Landmark, LayoutDashboard, ArrowLeftRight, RotateCcw, Users, Package, Receipt, Settings, ShoppingCart, Warehouse, type LucideIcon } from "lucide-react";
import type { Role } from "@/api/types";

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  roles: Role[];
}

const ALL: Role[] = ["ADMIN", "MANAGER", "CASHIER"];
const MANAGERS: Role[] = ["ADMIN", "MANAGER"];

export const NAV_ITEMS: NavItem[] = [
  { to: "/pos", label: "Checkout", icon: ShoppingCart, roles: ALL },
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard, roles: ALL },
  { to: "/sales", label: "Sales", icon: Receipt, roles: ALL },
  { to: "/shifts", label: "Shifts", icon: Landmark, roles: ALL },
  { to: "/returns", label: "Returns", icon: RotateCcw, roles: MANAGERS },
  { to: "/exchanges", label: "Exchanges", icon: ArrowLeftRight, roles: MANAGERS },
  { to: "/customers", label: "Customers", icon: Users, roles: ALL },
  { to: "/products", label: "Products", icon: Package, roles: MANAGERS },
  { to: "/inventory", label: "Inventory", icon: Warehouse, roles: MANAGERS },
  { to: "/reports", label: "Reports", icon: BarChart3, roles: MANAGERS },
  { to: "/settings", label: "Settings", icon: Settings, roles: ALL },
];

export const MANAGER_ROLES = MANAGERS;
export const ALL_ROLES = ALL;
export const roleLabel: Record<Role, string> = { ADMIN: "Administrator", MANAGER: "Manager", CASHIER: "Cashier" };

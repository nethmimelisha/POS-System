import { createContext, useContext, useEffect, useMemo, useReducer, type Dispatch, type ReactNode } from "react";
import { useAuth } from "@/auth/AuthProvider";
import { cartReducer, emptyCart, type CartAction, type CartState } from "./cartReducer";

const STORAGE_KEY = "pos.cart";

// The cart (never credentials) is kept in sessionStorage so a refresh does not lose a sale in progress.
function load(): CartState {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) return { ...emptyCart(), ...JSON.parse(raw) };
  } catch {
    /* ignore corrupt data */
  }
  return emptyCart();
}

const Ctx = createContext<{ cart: CartState; dispatch: Dispatch<CartAction> } | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const [cart, dispatch] = useReducer(cartReducer, undefined, load);
  const { user } = useAuth();

  useEffect(() => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(cart));
  }, [cart]);

  // A cart (and its sale id) belongs to the cashier who built it; never carry it over to someone else.
  useEffect(() => {
    if (!user) return;
    if (cart.ownerId && cart.ownerId !== user.id) dispatch({ type: "clear", ownerId: user.id });
    else if (!cart.ownerId) dispatch({ type: "owner", ownerId: user.id });
  }, [user, cart.ownerId]);

  const value = useMemo(() => ({ cart, dispatch }), [cart]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCart() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useCart must be used inside CartProvider");
  return v;
}

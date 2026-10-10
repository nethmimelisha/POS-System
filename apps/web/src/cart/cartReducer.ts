import type { Discount } from "@/api/types";
import type { Attempt } from "@/lib/checkoutAttempt";

export interface CartLine {
  variantId: string;
  sku: string;
  name: string;
  quantity: number;
  discount?: Discount;
}

export interface CartState {
  ownerId: string | null;
  lines: CartLine[];
  discount?: Discount;
  customer?: { id: string; name: string };
  attempt: Attempt | null;
}

export const emptyCart = (ownerId: string | null = null): CartState => ({ ownerId, lines: [], attempt: null });

export type CartAction =
  | { type: "add"; line: Omit<CartLine, "quantity" | "discount">; quantity: number }
  | { type: "setQty"; variantId: string; quantity: number }
  | { type: "remove"; variantId: string }
  | { type: "lineDiscount"; variantId: string; discount?: Discount }
  | { type: "cartDiscount"; discount?: Discount }
  | { type: "customer"; customer?: { id: string; name: string } }
  | { type: "attempt"; attempt: Attempt | null }
  | { type: "clear"; ownerId?: string | null }
  | { type: "owner"; ownerId: string | null };

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function cartReducer(state: CartState, action: CartAction): CartState {
  switch (action.type) {
    case "add": {
      const existing = state.lines.find((l) => l.variantId === action.line.variantId);
      const lines = existing
        ? state.lines.map((l) => (l === existing ? { ...l, quantity: round3(l.quantity + action.quantity) } : l))
        : [...state.lines, { ...action.line, quantity: action.quantity }];
      return { ...state, lines };
    }
    case "setQty":
      if (!(action.quantity > 0)) return state;
      return {
        ...state,
        lines: state.lines.map((l) => (l.variantId === action.variantId ? { ...l, quantity: round3(action.quantity) } : l)),
      };
    case "remove":
      return { ...state, lines: state.lines.filter((l) => l.variantId !== action.variantId) };
    case "lineDiscount":
      return {
        ...state,
        lines: state.lines.map((l) => (l.variantId === action.variantId ? { ...l, discount: action.discount } : l)),
      };
    case "cartDiscount":
      return { ...state, discount: action.discount };
    case "customer":
      return { ...state, customer: action.customer };
    case "attempt":
      return { ...state, attempt: action.attempt };
    case "clear":
      return emptyCart(action.ownerId === undefined ? state.ownerId : action.ownerId);
    case "owner":
      return { ...state, ownerId: action.ownerId };
  }
}

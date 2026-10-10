import { describe, expect, it } from "vitest";
import { cartReducer, emptyCart } from "./cartReducer";

const rice = { variantId: "v1", sku: "RICE", name: "Rice" };

describe("cartReducer", () => {
  it("merges repeated adds into one line", () => {
    let s = cartReducer(emptyCart("u1"), { type: "add", line: rice, quantity: 1 });
    s = cartReducer(s, { type: "add", line: rice, quantity: 2 });
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0].quantity).toBe(3);
  });
  it("rejects non-positive quantities", () => {
    const s = cartReducer(emptyCart(), { type: "add", line: rice, quantity: 2 });
    expect(cartReducer(s, { type: "setQty", variantId: "v1", quantity: 0 })).toBe(s);
  });
  it("sets and clears discounts", () => {
    let s = cartReducer(emptyCart(), { type: "add", line: rice, quantity: 1 });
    s = cartReducer(s, { type: "lineDiscount", variantId: "v1", discount: { type: "PERCENT", value: 5 } });
    expect(s.lines[0].discount).toEqual({ type: "PERCENT", value: 5 });
    s = cartReducer(s, { type: "cartDiscount", discount: { type: "AMOUNT", value: 50 } });
    expect(s.discount?.value).toBe(50);
  });
  it("clear keeps the owner but drops lines and attempt", () => {
    let s = cartReducer(emptyCart("u1"), { type: "add", line: rice, quantity: 1 });
    s = cartReducer(s, { type: "attempt", attempt: { id: "a", fingerprint: "{}", unknownOutcome: false } });
    s = cartReducer(s, { type: "clear" });
    expect(s).toEqual(emptyCart("u1"));
  });
});

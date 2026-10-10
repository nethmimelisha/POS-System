import { describe, expect, it } from "vitest";
import { priceSale } from "../src/services/pricing.js";

const off = { taxEnabled: false, pricesIncludeTax: true };

describe("pricing engine", () => {
  it("ignores tax while VAT is disabled", () => {
    const r = priceSale([{ unitPriceCents: 11800, quantity: 1, taxRatePct: 18 }], undefined, off);
    expect(r.taxCents).toBe(0);
    expect(r.grandTotalCents).toBe(11800);
  });

  it("extracts tax from tax-inclusive prices", () => {
    const r = priceSale([{ unitPriceCents: 11800, quantity: 1, taxRatePct: 18 }], undefined, {
      taxEnabled: true,
      pricesIncludeTax: true,
    });
    expect(r.taxCents).toBe(1800);
    expect(r.grandTotalCents).toBe(11800);
  });

  it("adds tax to tax-exclusive prices", () => {
    const r = priceSale([{ unitPriceCents: 11800, quantity: 1, taxRatePct: 18 }], undefined, {
      taxEnabled: true,
      pricesIncludeTax: false,
    });
    expect(r.taxCents).toBe(2124);
    expect(r.grandTotalCents).toBe(13924);
  });

  it("does not tax zero-rated or exempt lines", () => {
    const r = priceSale([{ unitPriceCents: 10000, quantity: 2, taxRatePct: null }], undefined, {
      taxEnabled: true,
      pricesIncludeTax: false,
    });
    expect(r.taxCents).toBe(0);
    expect(r.grandTotalCents).toBe(20000);
  });

  it("applies line then cart discounts and allocates to the exact cent", () => {
    const r = priceSale(
      [
        { unitPriceCents: 1000, quantity: 1, taxRatePct: null },
        { unitPriceCents: 1000, quantity: 1, taxRatePct: null },
        { unitPriceCents: 1000, quantity: 1, taxRatePct: null, discount: { type: "PERCENT", value: 10 } },
      ],
      { type: "AMOUNT", value: 1 },
      off,
    );
    expect(r.discountCents).toBe(100 + 100);
    expect(r.lines.reduce((a, l) => a + l.cartDiscountCents, 0)).toBe(100);
    expect(r.grandTotalCents).toBe(3000 - 200);
  });

  it("rejects discounts larger than the amount", () => {
    expect(() =>
      priceSale([{ unitPriceCents: 1000, quantity: 1, taxRatePct: null }], { type: "AMOUNT", value: 11 }, off),
    ).toThrow();
  });
});

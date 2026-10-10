import { HttpError } from "../middleware/error.js";

export type DiscountInput = { type: "PERCENT" | "AMOUNT"; value: number };

export interface PricingLineInput {
  unitPriceCents: number;
  quantity: number;
  discount?: DiscountInput;
  /** Percentage rate to apply, or null when the line is not taxable (zero-rated, exempt, untaxed). */
  taxRatePct: number | null;
}

export interface PricingSettings {
  taxEnabled: boolean;
  pricesIncludeTax: boolean;
}

export interface PricedLine {
  grossCents: number;
  lineDiscountCents: number;
  cartDiscountCents: number;
  /** Line discount plus this line's share of the cart discount. */
  discountCents: number;
  netCents: number;
  taxRatePct: number;
  taxCents: number;
  totalCents: number;
}

export interface PricingResult {
  lines: PricedLine[];
  /** Sum of unit price x quantity, before discounts. Tax-inclusive when prices include tax. */
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  grandTotalCents: number;
}

export const toCents = (n: number) => Math.round(n * 100);

function discountCents(base: number, d: DiscountInput | undefined, label: string): number {
  if (!d) return 0;
  const cents = d.type === "PERCENT" ? Math.round((base * d.value) / 100) : toCents(d.value);
  if (d.type === "PERCENT" && d.value > 100) throw new HttpError(400, `${label} percentage cannot exceed 100`);
  if (cents > base) throw new HttpError(400, `${label} cannot exceed the amount it applies to`);
  return cents;
}

/** Spreads a cart discount across lines in proportion to their value, to the exact cent. */
function allocate(total: number, bases: number[]): number[] {
  const sum = bases.reduce((a, b) => a + b, 0);
  if (total === 0 || sum === 0) return bases.map(() => 0);
  const shares = bases.map((b) => Math.floor((total * b) / sum));
  let remainder = total - shares.reduce((a, b) => a + b, 0);
  for (let i = 0; remainder > 0; i = (i + 1) % shares.length) {
    if (shares[i] < bases[i]) {
      shares[i]++;
      remainder--;
    }
  }
  return shares;
}

export function priceSale(
  inputs: PricingLineInput[],
  cartDiscount: DiscountInput | undefined,
  settings: PricingSettings,
): PricingResult {
  const gross = inputs.map((l) => Math.round(l.unitPriceCents * l.quantity));
  const lineDisc = inputs.map((l, i) => discountCents(gross[i], l.discount, "Line discount"));
  const afterLine = gross.map((g, i) => g - lineDisc[i]);
  const cartTotal = discountCents(
    afterLine.reduce((a, b) => a + b, 0),
    cartDiscount,
    "Cart discount",
  );
  const cartShares = allocate(cartTotal, afterLine);

  const lines: PricedLine[] = inputs.map((l, i) => {
    const net = afterLine[i] - cartShares[i];
    const rate = settings.taxEnabled && l.taxRatePct && l.taxRatePct > 0 ? l.taxRatePct : 0;
    let tax = 0;
    let total = net;
    if (rate > 0) {
      if (settings.pricesIncludeTax) {
        tax = Math.round((net * rate) / (100 + rate));
      } else {
        tax = Math.round((net * rate) / 100);
        total = net + tax;
      }
    }
    return {
      grossCents: gross[i],
      lineDiscountCents: lineDisc[i],
      cartDiscountCents: cartShares[i],
      discountCents: lineDisc[i] + cartShares[i],
      netCents: net,
      taxRatePct: rate,
      taxCents: tax,
      totalCents: total,
    };
  });

  const sum = (f: (l: PricedLine) => number) => lines.reduce((a, l) => a + f(l), 0);
  return {
    lines,
    subtotalCents: sum((l) => l.grossCents),
    discountCents: sum((l) => l.discountCents),
    taxCents: sum((l) => l.taxCents),
    grandTotalCents: sum((l) => l.totalCents),
  };
}

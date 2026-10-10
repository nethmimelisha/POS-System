const num = (v: string | number) => (typeof v === "number" ? v : Number(v));

export function formatMoney(value: string | number, symbol = "Rs."): string {
  const n = num(value);
  const abs = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? "-" : ""}${symbol} ${abs}`;
}

export function formatQty(value: string | number): string {
  return num(value).toLocaleString("en-US", { maximumFractionDigits: 3 });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-LK", { dateStyle: "medium", timeStyle: "short" });
}

export const toCents = (value: string | number) => Math.round(num(value) * 100);
export const fromCents = (cents: number) => cents / 100;

export function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

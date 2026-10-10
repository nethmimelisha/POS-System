export interface ScanInput {
  code: string;
  quantity: number;
}

/**
 * Parses what the cashier typed or a scanner sent. "3*4791000000011" means quantity 3 of that code,
 * a common POS shortcut. Anything else is a plain code with quantity 1.
 */
export function parseScanInput(raw: string): ScanInput | null {
  const text = raw.trim();
  if (!text) return null;
  const m = /^(\d+(?:\.\d{1,3})?)\s*\*\s*(\S.*)$/.exec(text);
  if (m) {
    const quantity = Number(m[1]);
    if (quantity > 0 && quantity <= 100_000) return { quantity, code: m[2].trim() };
  }
  return { code: text, quantity: 1 };
}

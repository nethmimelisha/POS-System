import { describe, expect, it } from "vitest";
import { parseScanInput } from "./scan";
import { fingerprint, resolveAttempt, uuid, type SalePayload } from "./checkoutAttempt";
import { formatMoney, toCents } from "./format";

describe("parseScanInput", () => {
  it("parses plain codes and quantity prefixes", () => {
    expect(parseScanInput(" 4791000000011 ")).toEqual({ code: "4791000000011", quantity: 1 });
    expect(parseScanInput("3*4791000000011")).toEqual({ code: "4791000000011", quantity: 3 });
    expect(parseScanInput("2.5 * RICE-1KG")).toEqual({ code: "RICE-1KG", quantity: 2.5 });
  });
  it("ignores empty input and invalid quantities", () => {
    expect(parseScanInput("   ")).toBeNull();
    expect(parseScanInput("0*abc")).toEqual({ code: "0*abc", quantity: 1 });
  });
});

const payload = (amount: number): SalePayload => ({ registerId: 1, items: [{ variantId: "v", quantity: 1 }], payments: [{ method: "cash", amount }] });

describe("resolveAttempt", () => {
  it("creates a uuid-shaped id", () => {
    expect(uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it("reuses the id for an unchanged payload", () => {
    const a = resolveAttempt(null, payload(100));
    expect(resolveAttempt(a, payload(100))).toBe(a);
  });
  it("issues a new id when the payload changed after a known failure", () => {
    const a = resolveAttempt(null, payload(100));
    expect(resolveAttempt(a, payload(200)).id).not.toBe(a.id);
  });
  it("refuses a changed payload after an unknown outcome", () => {
    const a = { ...resolveAttempt(null, payload(100)), unknownOutcome: true };
    expect(() => resolveAttempt(a, payload(200))).toThrow();
    expect(resolveAttempt(a, payload(100))).toBe(a);
    expect(a.fingerprint).toBe(fingerprint(payload(100)));
  });
});

describe("format", () => {
  it("formats LKR amounts like Rs. 1,500.00", () => {
    expect(formatMoney(1500)).toBe("Rs. 1,500.00");
    expect(formatMoney("0.5")).toBe("Rs. 0.50");
    expect(formatMoney(-20)).toBe("-Rs. 20.00");
  });
  it("converts to cents without float drift", () => {
    expect(toCents("19.99")).toBe(1999);
    expect(toCents(0.1 + 0.2)).toBe(30);
  });
});

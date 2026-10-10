import type { SaleInput } from "@/api/types";

export type SalePayload = Omit<SaleInput, "id">;

/**
 * A checkout attempt owns one sale id. Re-sending the same id with the same payload is safe (the server
 * replays the original sale), so every retry of an unchanged payment reuses it.
 */
export interface Attempt {
  id: string;
  fingerprint: string;
  /** True after a network failure: the sale may or may not exist on the server. */
  unknownOutcome: boolean;
}

export function uuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // randomUUID needs a secure context; tablets on a plain-http LAN address do not have one.
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const fingerprint = (payload: SalePayload) => JSON.stringify(payload);

/**
 * Returns the attempt to use for this payload. An unchanged payload keeps its id. A changed payload gets
 * a new id, except after an unknown outcome: then the original request must be repeated unchanged, because
 * a new id could create a second sale if the first one actually went through.
 */
export function resolveAttempt(prev: Attempt | null, payload: SalePayload): Attempt {
  const fp = fingerprint(payload);
  if (prev && prev.fingerprint === fp) return prev;
  if (prev?.unknownOutcome) {
    throw new Error("The previous attempt has an unknown outcome and must be retried unchanged");
  }
  return { id: uuid(), fingerprint: fp, unknownOutcome: false };
}

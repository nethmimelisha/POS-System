import { encodeReceipt } from "./escpos";
import type { CashDrawer, PrintJob, PrintResult, RawTransport, ReceiptPrinter } from "./types";

/** Always available. Prints the on-screen 80 mm receipt layout through the browser print dialog. */
export class BrowserReceiptPrinter implements ReceiptPrinter {
  readonly kind = "browser";
  readonly label = "Browser print (80 mm layout)";
  isAvailable() {
    return typeof window !== "undefined" && typeof window.print === "function";
  }
  async print(): Promise<void> {
    window.print();
  }
}

/** ESC/POS over a transport. Without a transport it reports unavailable, so callers fall back to the browser. */
export class EscPosPrinter implements ReceiptPrinter, CashDrawer {
  readonly kind = "escpos";
  readonly label: string;
  constructor(private readonly transport: RawTransport | null) {
    this.label = transport ? `ESC/POS via ${transport.name}` : "ESC/POS (no transport configured)";
  }
  isAvailable() {
    return !!this.transport?.isAvailable();
  }
  isSupported() {
    return this.isAvailable();
  }
  async print(job: PrintJob): Promise<void> {
    if (!this.transport || !job.lines) throw new Error("ESC/POS printing needs a transport and receipt lines");
    await this.transport.write(encodeReceipt(job.lines, { openDrawer: job.openDrawer }));
  }
  async open(): Promise<boolean> {
    if (!this.transport?.isAvailable()) return false;
    await this.transport.write(encodeReceipt([], { cut: false, openDrawer: true }));
    return true;
  }
}

/** Prints with the first available preferred printer and falls back to the browser dialog if it fails. */
export async function printWithFallback(job: PrintJob, preferred: ReceiptPrinter[], fallback: ReceiptPrinter = new BrowserReceiptPrinter()): Promise<PrintResult> {
  let failed: string | undefined;
  let error: string | undefined;
  for (const p of preferred) {
    if (!p.isAvailable()) continue;
    try {
      await p.print(job);
      return { ok: true, printer: p.kind };
    } catch (e) {
      failed = p.kind;
      error = e instanceof Error ? e.message : String(e);
    }
  }
  try {
    await fallback.print(job);
    return { ok: true, printer: fallback.kind, fellBackFrom: failed, error };
  } catch (e) {
    return { ok: false, printer: fallback.kind, fellBackFrom: failed, error: e instanceof Error ? e.message : String(e) };
  }
}
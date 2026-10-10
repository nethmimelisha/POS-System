import { UnsupportedCashDrawer } from "./drawer";
import { BrowserReceiptPrinter, EscPosPrinter, printWithFallback } from "./printer";
import { KeyboardWedgeScanner } from "./scanner";
import type { BarcodeScanner, CashDrawer, PrintJob, PrintResult, RawTransport, ReceiptPrinter } from "./types";

export * from "./types";
export { encodeReceipt, WIDTH_80MM } from "./escpos";
export { BrowserReceiptPrinter, EscPosPrinter, printWithFallback } from "./printer";
export { KeyboardWedgeScanner, WedgeDetector } from "./scanner";
export { UnsupportedCashDrawer } from "./drawer";

interface Hardware {
  scanner: BarcodeScanner;
  printers: ReceiptPrinter[];
  drawer: CashDrawer;
}

// Defaults need no hardware: keyboard-mode scanner, browser printing, no cash drawer.
let hardware: Hardware = { scanner: new KeyboardWedgeScanner(), printers: [], drawer: new UnsupportedCashDrawer() };

export const getScanner = () => hardware.scanner;
export const getDrawer = () => hardware.drawer;

/** Plugs in a raw transport (once one exists and its hardware is confirmed). Browser printing stays as the fallback. */
export function registerRawTransport(transport: RawTransport) {
  const escpos = new EscPosPrinter(transport);
  hardware = { ...hardware, printers: [escpos], drawer: escpos };
}

export function printReceipt(job: PrintJob = {}): Promise<PrintResult> {
  return printWithFallback(job, hardware.printers, new BrowserReceiptPrinter());
}

export function resetHardware() {
  hardware = { scanner: new KeyboardWedgeScanner(), printers: [], drawer: new UnsupportedCashDrawer() };
}
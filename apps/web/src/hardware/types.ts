/**
 * Hardware abstraction layer.
 *
 * Browsers cannot reach every USB or network printer, so nothing here assumes direct device access.
 * Every capability reports whether it is available, and the browser print dialog is the guaranteed fallback.
 * No specific hardware model is selected; real ESC/POS and cash-drawer transports are added later behind these interfaces.
 */

export type Unsubscribe = () => void;

export interface BarcodeScanner {
  readonly kind: string;
  /** Starts listening. Returns a function that stops it. */
  start(onScan: (code: string) => void): Unsubscribe;
}

export interface PrintJob {
  /** Receipt content for transports that print raw data (ESC/POS). Browser printing prints the page layout instead. */
  lines?: ReceiptLine[];
  /** Open the cash drawer after printing, where supported. */
  openDrawer?: boolean;
}

export interface ReceiptLine {
  text: string;
  align?: "left" | "center" | "right";
  bold?: boolean;
  /** Right-aligned text on the same line, for "item ..... amount" rows. */
  right?: string;
}

export interface PrintResult {
  ok: boolean;
  printer: string;
  /** Set when a preferred printer failed and the browser fallback was used. */
  fellBackFrom?: string;
  error?: string;
}

export interface ReceiptPrinter {
  readonly kind: string;
  readonly label: string;
  isAvailable(): boolean;
  print(job: PrintJob): Promise<void>;
}

export interface CashDrawer {
  readonly kind: string;
  isSupported(): boolean;
  /** Resolves false when the drawer cannot be opened; never throws for "unsupported". */
  open(): Promise<boolean>;
}

/** A byte sink for raw printer commands (WebUSB, Web Serial, a local print agent, ...). Not implemented yet. */
export interface RawTransport {
  readonly name: string;
  isAvailable(): boolean;
  write(bytes: Uint8Array): Promise<void>;
}
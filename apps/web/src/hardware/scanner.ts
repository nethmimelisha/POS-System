import type { BarcodeScanner, Unsubscribe } from "./types";

export interface WedgeOptions {
  /** Maximum gap between keystrokes for them to count as scanner input. USB scanners type far faster than people. */
  maxKeyGapMs?: number;
  minLength?: number;
  now?: () => number;
}

/**
 * Detects USB scanners that behave as a keyboard ("HID keyboard wedge"). Pure state machine so it can be tested without a DOM.
 * Characters arrive quickly and end with Enter. Slow typing never produces a scan.
 */
export class WedgeDetector {
  private buffer = "";
  private last = 0;
  private readonly gap: number;
  private readonly min: number;
  private readonly now: () => number;

  constructor(opts: WedgeOptions = {}) {
    this.gap = opts.maxKeyGapMs ?? 50;
    this.min = opts.minLength ?? 4;
    this.now = opts.now ?? Date.now;
  }

  /** Feed one key. Returns the scanned code when a complete, fast burst ended with Enter. */
  key(key: string): string | null {
    const t = this.now();
    if (key === "Enter") {
      const code = this.buffer;
      this.buffer = "";
      return code.length >= this.min ? code : null;
    }
    if (key.length !== 1) return null;
    if (t - this.last > this.gap) this.buffer = "";
    this.last = t;
    this.buffer += key;
    return null;
  }
}

/** Listens on the window, so a scan is captured even when no input has focus. Typing in a text field is left alone. */
export class KeyboardWedgeScanner implements BarcodeScanner {
  readonly kind = "usb-keyboard-wedge";
  constructor(private readonly opts: WedgeOptions = {}) {}

  start(onScan: (code: string) => void): Unsubscribe {
    const detector = new WedgeDetector(this.opts);
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const editing = !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      const code = detector.key(e.key);
      // Inputs handle their own Enter (the POS search box parses scans itself); only unfocused scans are captured here.
      if (code && !editing) {
        e.preventDefault();
        onScan(code);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }
}
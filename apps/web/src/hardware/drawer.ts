import type { CashDrawer } from "./types";

/** Default drawer: nothing is connected, so opening is reported as unsupported instead of failing. */
export class UnsupportedCashDrawer implements CashDrawer {
  readonly kind = "none";
  isSupported() {
    return false;
  }
  async open() {
    return false;
  }
}
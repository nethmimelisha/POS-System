import { describe, expect, it, vi } from "vitest";
import { COMMANDS, encodeReceipt } from "./escpos";
import { BrowserReceiptPrinter, printWithFallback } from "./printer";
import { WedgeDetector } from "./scanner";
import { getDrawer, printReceipt, registerRawTransport, resetHardware } from "./index";

describe("keyboard wedge scanner detection", () => {
  const feed = (d: WedgeDetector, text: string, gap: number, clock: { t: number }) => {
    let out: string | null = null;
    for (const c of text) {
      clock.t += gap;
      out = d.key(c);
    }
    clock.t += gap;
    return d.key("Enter") ?? out;
  };

  it("accepts fast bursts ending in Enter", () => {
    const clock = { t: 1000 };
    expect(feed(new WedgeDetector({ now: () => clock.t }), "4791234567890", 10, clock)).toBe("4791234567890");
  });

  it("ignores human-speed typing", () => {
    const clock = { t: 1000 };
    expect(feed(new WedgeDetector({ now: () => clock.t }), "4791234567890", 200, clock)).toBeNull();
  });

  it("ignores very short input", () => {
    const clock = { t: 1000 };
    expect(feed(new WedgeDetector({ now: () => clock.t }), "12", 5, clock)).toBeNull();
  });
});

describe("ESC/POS encoding", () => {
  it("starts with init, ends with cut and appends the drawer kick on request", () => {
    const bytes = encodeReceipt([{ text: "Hello", align: "center" }], { openDrawer: true });
    expect(Array.from(bytes.slice(0, 2))).toEqual([...COMMANDS.init]);
    expect(Array.from(bytes.slice(-5))).toEqual([...COMMANDS.drawerKick]);
    expect(Array.from(bytes.slice(-9, -5))).toEqual([...COMMANDS.cut]);
  });

  it("lays out right-aligned amounts on a 48 column line and strips non-ASCII", () => {
    const bytes = encodeReceipt([{ text: "Rice 1kg", right: "Rs. 250.00" }, { text: "Café" }], { cut: false });
    const text = String.fromCharCode(...bytes);
    expect(text).toContain("Rice 1kg" + " ".repeat(48 - 8 - 10) + "Rs. 250.00");
    expect(text).toContain("Cafe");
  });
});

describe("printing with fallback", () => {
  it("uses the browser dialog when nothing else is available", async () => {
    window.print = vi.fn();
    const r = await printReceipt();
    expect(r).toMatchObject({ ok: true, printer: "browser" });
    expect(window.print).toHaveBeenCalledOnce();
  });

  it("falls back to the browser when the ESC/POS transport fails", async () => {
    window.print = vi.fn();
    registerRawTransport({ name: "test", isAvailable: () => true, write: async () => { throw new Error("device offline"); } });
    const r = await printReceipt({ lines: [{ text: "x" }] });
    expect(r).toMatchObject({ ok: true, printer: "browser", fellBackFrom: "escpos", error: "device offline" });
    expect(window.print).toHaveBeenCalledOnce();
    resetHardware();
  });

  it("prints through the transport when it works and reports drawer support honestly", async () => {
    const writes: Uint8Array[] = [];
    window.print = vi.fn();
    expect(getDrawer().isSupported()).toBe(false);
    registerRawTransport({ name: "test", isAvailable: () => true, write: async (b) => void writes.push(b) });
    expect(await printReceipt({ lines: [{ text: "x" }] })).toMatchObject({ ok: true, printer: "escpos" });
    expect(window.print).not.toHaveBeenCalled();
    expect(await getDrawer().open()).toBe(true);
    expect(writes).toHaveLength(2);
    resetHardware();
  });

  it("reports failure when even the browser cannot print", async () => {
    const broken = { kind: "browser", label: "x", isAvailable: () => true, print: async () => { throw new Error("blocked"); } };
    expect(await printWithFallback({}, [], broken)).toMatchObject({ ok: false, error: "blocked" });
    expect(new BrowserReceiptPrinter().isAvailable()).toBe(true);
  });
});
import type { ReceiptLine } from "./types";

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

/** Characters per line on an 80 mm printer in Font A. */
export const WIDTH_80MM = 48;

export const COMMANDS = {
  init: [ESC, 0x40],
  boldOn: [ESC, 0x45, 1],
  boldOff: [ESC, 0x45, 0],
  alignLeft: [ESC, 0x61, 0],
  alignCenter: [ESC, 0x61, 1],
  alignRight: [ESC, 0x61, 2],
  cut: [GS, 0x56, 0x42, 0x03],
  // ESC p m t1 t2: pulse pin 2. Drawer wiring and timing differ per model, so this is a default to be confirmed with real hardware.
  drawerKick: [ESC, 0x70, 0x00, 0x19, 0xfa],
} as const;

const ascii = (s: string) => Array.from(s.normalize("NFKD").replace(/[^\x20-\x7e]/g, "?")).map((c) => c.charCodeAt(0));

/** Builds raw ESC/POS bytes. Pure and hardware-independent; sending them needs a RawTransport. */
export function encodeReceipt(lines: ReceiptLine[], opts: { width?: number; cut?: boolean; openDrawer?: boolean } = {}): Uint8Array {
  const width = opts.width ?? WIDTH_80MM;
  const out: number[] = [...COMMANDS.init];
  for (const l of lines) {
    out.push(...(l.bold ? COMMANDS.boldOn : COMMANDS.boldOff));
    if (l.right !== undefined) {
      const left = l.text.slice(0, Math.max(0, width - l.right.length - 1));
      out.push(...COMMANDS.alignLeft, ...ascii(left.padEnd(width - l.right.length) + l.right), LF);
    } else {
      out.push(...(l.align === "center" ? COMMANDS.alignCenter : l.align === "right" ? COMMANDS.alignRight : COMMANDS.alignLeft), ...ascii(l.text), LF);
    }
  }
  out.push(...COMMANDS.boldOff, ...COMMANDS.alignLeft, LF, LF, LF);
  if (opts.cut !== false) out.push(...COMMANDS.cut);
  if (opts.openDrawer) out.push(...COMMANDS.drawerKick);
  return Uint8Array.from(out);
}
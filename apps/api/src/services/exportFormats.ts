import PDFDocument from "pdfkit";

export type ColumnType = "text" | "money" | "qty" | "date";
export interface Column {
  key: string;
  label: string;
  type?: ColumnType;
}
export type Row = Record<string, unknown>;

const NUMERIC = /^-?\d+(\.\d+)?$/;
// Characters that make Excel, LibreOffice and Google Sheets treat a cell as a formula.
const FORMULA_START = /^[\s]*[=+\-@\t\r\n|%]/;

/**
 * Neutralises spreadsheet formula injection. Free text (product names, customer-supplied notes, reasons)
 * that could start a formula gets a leading apostrophe so it is displayed, never evaluated.
 * Server-calculated numbers are written untouched so negatives such as a -50.00 shortage stay numeric;
 * a "number" column that does not actually hold a plain number is treated as text.
 */
export function csvCell(value: unknown, type: ColumnType = "text"): string {
  if (value === null || value === undefined) return "";
  let s = value instanceof Date ? value.toISOString() : String(value);
  const numeric = (type === "money" || type === "qty") && NUMERIC.test(s);
  if (!numeric && FORMULA_START.test(s)) s = `'${s}`;
  // RFC 4180: quote fields containing separators, quotes or line breaks.
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(columns: Column[], rows: Row[]): string {
  const lines = [columns.map((c) => csvCell(c.label)).join(",")];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c.key], c.type)).join(","));
  // BOM so Excel opens UTF-8 correctly; CRLF per RFC 4180.
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

export interface PdfSpec {
  title: string;
  business: string;
  subtitle: string[];
  columns: Column[];
  rows: Row[];
  totals: [string, string][];
}

const weight: Record<ColumnType, number> = { text: 2, money: 1.2, qty: 0.9, date: 1.5 };

/** Renders server-calculated report rows as a PDF. Values are printed exactly as the API produced them. */
export function renderPdf(spec: PdfSpec): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const landscape = spec.columns.length > 6;
    const doc = new PDFDocument({ size: "A4", layout: landscape ? "landscape" : "portrait", margin: 36, bufferPages: true, info: { Title: spec.title, Producer: "POS" } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const bottom = () => doc.page.height - doc.page.margins.bottom - 18;
    const totalWeight = spec.columns.reduce((a, c) => a + weight[c.type ?? "text"], 0);
    const widths = spec.columns.map((c) => (width * weight[c.type ?? "text"]) / totalWeight);
    const x = (i: number) => left + widths.slice(0, i).reduce((a, b) => a + b, 0);

    doc.font("Helvetica-Bold").fontSize(15).fillColor("#0b1f44").text(spec.title);
    doc.font("Helvetica").fontSize(9).fillColor("#444").text(spec.business);
    for (const line of spec.subtitle) doc.text(line);
    doc.moveDown(0.6);

    if (spec.totals.length) {
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#0b1f44").text("Totals");
      doc.font("Helvetica").fillColor("#000");
      for (const [label, value] of spec.totals) doc.text(`${label}: ${value}`);
      doc.moveDown(0.6);
    }

    const header = () => {
      const y = doc.y;
      doc.rect(left, y - 2, width, 16).fill("#0b1f44");
      doc.fillColor("#fff").font("Helvetica-Bold").fontSize(8);
      spec.columns.forEach((c, i) => doc.text(c.label, x(i) + 3, y + 2, { width: widths[i] - 6, lineBreak: false, ellipsis: true, align: c.type === "money" || c.type === "qty" ? "right" : "left" }));
      doc.y = y + 18;
      doc.fillColor("#000").font("Helvetica").fontSize(8);
    };
    header();

    spec.rows.forEach((row, n) => {
      if (doc.y > bottom() - 12) {
        doc.addPage();
        header();
      }
      const y = doc.y;
      if (n % 2 === 1) doc.rect(left, y - 2, width, 13).fill("#f1f4fa").fillColor("#000");
      spec.columns.forEach((c, i) => {
        const v = row[c.key];
        doc.text(v === null || v === undefined ? "" : String(v), x(i) + 3, y, {
          width: widths[i] - 6,
          lineBreak: false,
          ellipsis: true,
          align: c.type === "money" || c.type === "qty" ? "right" : "left",
        });
      });
      doc.y = y + 13;
    });
    if (!spec.rows.length) doc.text("No rows for the selected filters.", left, doc.y + 4);

    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc.font("Helvetica").fontSize(7).fillColor("#666");
      doc.text(`Page ${i + 1} of ${range.count}`, left, doc.page.height - doc.page.margins.bottom + 6, { width, align: "right", lineBreak: false });
    }
    doc.end();
  });
}

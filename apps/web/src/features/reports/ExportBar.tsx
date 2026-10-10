import { useState } from "react";
import { Download, FileText } from "lucide-react";
import { download, errorMessage } from "@/api/client";
import type { ExportReport } from "@/api/types";
import { Alert, Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";

const REPORTS: { value: ExportReport; label: string; dated: boolean }[] = [
  { value: "sales", label: "Sales", dated: true },
  { value: "refunds", label: "Refunds", dated: true },
  { value: "shifts", label: "Cashier shifts", dated: true },
  { value: "tax", label: "Tax", dated: true },
  { value: "inventory", label: "Inventory (current stock)", dated: false },
  { value: "products", label: "Product list", dated: false },
];

/** Server-generated CSV and PDF files. The same date range and permissions as the on-screen reports apply. */
export function ExportBar({ from, to, disabled }: { from?: string; to?: string; disabled?: boolean }) {
  const toast = useToast();
  const [report, setReport] = useState<ExportReport>("sales");
  const [busy, setBusy] = useState<"csv" | "pdf" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dated = REPORTS.find((r) => r.value === report)!.dated;

  async function run(format: "csv" | "pdf") {
    setBusy(format);
    setError(null);
    try {
      const name = await download(`/exports/${report}.${format}`, dated ? { from, to } : {}, `${report}.${format}`);
      toast.success(`Downloaded ${name}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="mb-5 p-4" >
      <div className="flex flex-wrap items-end gap-3" data-testid="export-bar">
        <Select label="Export" wrapperClassName="min-w-56" value={report} onChange={(e) => setReport(e.target.value as ExportReport)}>
          {REPORTS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </Select>
        <Button variant="secondary" icon={<Download className="size-4" />} loading={busy === "csv"} disabled={disabled || !!busy} onClick={() => void run("csv")}>
          CSV
        </Button>
        <Button variant="secondary" icon={<FileText className="size-4" />} loading={busy === "pdf"} disabled={disabled || !!busy} onClick={() => void run("pdf")}>
          PDF
        </Button>
        <p className="pb-2 text-xs text-slate-500">{dated ? "Uses the date range above." : "Current snapshot; date range does not apply."}</p>
      </div>
      {error && (
        <div className="mt-3">
          <Alert>{error}</Alert>
        </div>
      )}
    </Card>
  );
}
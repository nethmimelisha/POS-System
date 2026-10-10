import { useState } from "react";
import type { Discount } from "@/api/types";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";

interface Props {
  open: boolean;
  title: string;
  value?: Discount;
  onApply: (d: Discount | undefined) => void;
  onClose: () => void;
}

export function DiscountModal({ open, title, value, onApply, onClose }: Props) {
  if (!open) return null;
  return <Inner key={title} title={title} value={value} onApply={onApply} onClose={onClose} />;
}

function Inner({ title, value, onApply, onClose }: Omit<Props, "open">) {
  const [type, setType] = useState<Discount["type"]>(value?.type ?? "PERCENT");
  const [text, setText] = useState(value ? String(value.value) : "");
  const n = Number(text);
  const error = text === "" ? undefined : !(n > 0) ? "Enter a number greater than 0" : type === "PERCENT" && n > 100 ? "A percentage cannot exceed 100" : undefined;
  const valid = text !== "" && !error;

  const submit = () => {
    if (!valid) return;
    onApply({ type, value: n });
    onClose();
  };

  return (
    <Modal
      open
      title={title}
      onClose={onClose}
      size="sm"
      footer={
        <>
          {value && (
            <Button
              variant="ghost"
              className="mr-auto text-red-600"
              onClick={() => {
                onApply(undefined);
                onClose();
              }}
            >
              Remove
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!valid}>
            Apply
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="space-y-4"
      >
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1" role="radiogroup" aria-label="Discount type">
          {(["PERCENT", "AMOUNT"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={type === t}
              onClick={() => setType(t)}
              className={`h-9 rounded-md text-sm font-medium ${type === t ? "bg-white text-navy-900 shadow-sm" : "text-slate-500"}`}
            >
              {t === "PERCENT" ? "Percent (%)" : "Amount (Rs.)"}
            </button>
          ))}
        </div>
        <Input label={type === "PERCENT" ? "Percentage" : "Amount (Rs.)"} inputMode="decimal" autoFocus value={text} onChange={(e) => setText(e.target.value)} error={error} />
        <p className="text-xs text-slate-500">The server checks that this discount is allowed for your role.</p>
      </form>
    </Modal>
  );
}

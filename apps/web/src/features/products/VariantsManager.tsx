import { useState } from "react";
import { Pencil, Plus } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import { errorMessage } from "@/api/client";
import type { Variant } from "@/api/types";
import { Alert, Badge } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Checkbox, Input } from "@/components/ui/Input";
import { formatMoney, formatQty } from "@/lib/format";

export function VariantsManager({ productId, productName }: { productId: string; productName: string }) {
  const [editing, setEditing] = useState<Variant | "new" | null>(null);
  const q = useQuery({
    queryKey: ["products", "variants", productId],
    queryFn: async () => (await api.products({ search: productName, pageSize: 50 })).items.find((p) => p.id === productId)?.variants ?? [],
  });

  return (
    <section className="mt-6 border-t border-slate-200 pt-4" data-testid="variants-manager">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-navy-950">Variants</h3>
        {!editing && (
          <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setEditing("new")}>
            Add variant
          </Button>
        )}
      </div>
      {q.isError && <Alert>{errorMessage(q.error)}</Alert>}
      {editing ? (
        <VariantForm
          productId={productId}
          variant={editing === "new" ? null : editing}
          onDone={() => {
            setEditing(null);
            void q.refetch();
          }}
        />
      ) : (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {q.data?.map((v) => (
            <li key={v.id} className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm" data-testid="variant-row">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{v.name || "Default"}</span>
                  <span className="text-slate-500">{v.sku}</span>
                  {!v.isActive && <Badge tone="slate">inactive</Badge>}
                </div>
                <div className="truncate text-xs text-slate-500">
                  {formatMoney(v.sellPrice)} · cost {formatMoney(v.costPrice)} · stock {formatQty(v.stockLevel?.onHand ?? "0")} · reorder {formatQty(v.reorderLevel)}
                  {v.barcodes.length > 0 && ` · ${v.barcodes.map((b) => b.barcode).join(", ")}`}
                </div>
              </div>
              <Button variant="ghost" size="sm" aria-label={`Edit variant ${v.sku}`} icon={<Pencil className="size-4" />} onClick={() => setEditing(v)}>
                Edit
              </Button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs text-slate-500">Past sales keep the name, SKU and price they were sold with.</p>
    </section>
  );
}

function VariantForm({ productId, variant, onDone }: { productId: string; variant: Variant | null; onDone: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(variant?.name ?? "");
  const [sku, setSku] = useState(variant?.sku ?? "");
  const [barcodes, setBarcodes] = useState(variant?.barcodes.map((b) => b.barcode).join(", ") ?? "");
  const [cost, setCost] = useState(variant ? String(Number(variant.costPrice)) : "0");
  const [sell, setSell] = useState(variant ? String(Number(variant.sellPrice)) : "");
  const [reorder, setReorder] = useState(variant ? String(Number(variant.reorderLevel)) : "0");
  const [opening, setOpening] = useState("");
  const [active, setActive] = useState(variant?.isActive ?? true);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const data = {
        sku: sku.trim(),
        name: name.trim() || null,
        barcodes: [...new Set(barcodes.split(",").map((b) => b.trim()).filter(Boolean))],
        costPrice: Number(cost),
        sellPrice: Number(sell),
        reorderLevel: Number(reorder),
      };
      return variant ? api.updateVariant(variant.id, { ...data, isActive: active }) : api.addVariant(productId, { ...data, ...(Number(opening) > 0 ? { openingStock: Number(opening) } : {}) });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["products"] });
      void qc.invalidateQueries({ queryKey: ["pos-search"] });
      void qc.invalidateQueries({ queryKey: ["inventory"] });
      onDone();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const invalid = !sku.trim() || sell.trim() === "" || !(Number(sell) >= 0) || !(Number(cost) >= 0) || !(Number(reorder) >= 0) || (opening !== "" && !(Number(opening) >= 0));

  return (
    <div className="grid gap-3 rounded-lg border border-slate-200 bg-slate-50/60 p-4 sm:grid-cols-2" data-testid="variant-form">
      {error && (
        <div className="sm:col-span-2">
          <Alert>{error}</Alert>
        </div>
      )}
      <Input label="Variant name" hint="e.g. 500 g, Large" value={name} onChange={(e) => setName(e.target.value)} />
      <Input label="Variant SKU" value={sku} onChange={(e) => setSku(e.target.value)} />
      <Input wrapperClassName="sm:col-span-2" label="Variant barcodes" hint="Separate several with commas" value={barcodes} onChange={(e) => setBarcodes(e.target.value)} />
      <Input label="Variant cost (Rs.)" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} />
      <Input label="Variant selling price (Rs.)" inputMode="decimal" value={sell} onChange={(e) => setSell(e.target.value)} />
      <Input label="Variant reorder level" inputMode="decimal" value={reorder} onChange={(e) => setReorder(e.target.value)} />
      {variant ? (
        <Checkbox label="Variant active" hint="Inactive variants cannot be sold" checked={active} onChange={(e) => setActive(e.target.checked)} />
      ) : (
        <Input label="Opening stock" inputMode="decimal" value={opening} onChange={(e) => setOpening(e.target.value)} />
      )}
      <div className="flex justify-end gap-2 sm:col-span-2">
        <Button variant="secondary" onClick={onDone} disabled={save.isPending}>
          Cancel
        </Button>
        <Button loading={save.isPending} disabled={invalid} onClick={() => (setError(null), save.mutate())}>
          Save variant
        </Button>
      </div>
      {variant && <p className="text-xs text-slate-500 sm:col-span-2">Stock quantities change through Inventory adjustments, not here.</p>}
    </div>
  );
}

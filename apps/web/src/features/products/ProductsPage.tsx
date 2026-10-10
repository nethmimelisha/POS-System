import { useState, type FormEvent } from "react";
import { Pencil, Plus, Search } from "lucide-react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import { errorMessage } from "@/api/client";
import type { Product } from "@/api/types";
import { Alert, Badge, Card, EmptyState, ErrorState, LoadingBlock, PageHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Checkbox, Input, Select } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { formatMoney, formatQty } from "@/lib/format";
import { VariantsManager } from "./VariantsManager";

export function ProductsPage() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Product | "new" | null>(null);
  const q = useQuery({ queryKey: ["products", search, page], queryFn: () => api.products({ search: search.trim() || undefined, page, pageSize: 25 }), placeholderData: keepPreviousData });
  const pages = q.data ? Math.max(1, Math.ceil(q.data.total / 25)) : 1;

  return (
    <div className="mx-auto max-w-6xl p-4 lg:p-8">
      <PageHeader title="Products" subtitle="Catalogue, prices and barcodes" actions={<Button icon={<Plus className="size-4" />} onClick={() => setEditing("new")}>New product</Button>} />
      <div className="mb-4 max-w-md">
        <Input
          aria-label="Search products"
          placeholder="Search by name, SKU or barcode"
          leading={<Search className="size-4" />}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
      </div>
      <Card className="overflow-hidden">
        {q.isPending ? (
          <LoadingBlock />
        ) : q.isError ? (
          <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />
        ) : q.data.items.length === 0 ? (
          <EmptyState title="No products found" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm" data-testid="products-table">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Product</th>
                  <th className="px-4 py-3">SKU / Barcode</th>
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3 text-right">Price</th>
                  <th className="px-4 py-3 text-right">Stock</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {q.data.items.flatMap((p) =>
                  p.variants.map((v) => (
                    <tr key={v.id} className={p.isActive && v.isActive ? "" : "opacity-50"}>
                      <td className="px-4 py-3 font-medium text-slate-900">
                        {v.name ? `${p.name} – ${v.name}` : p.name}
                        {!(p.isActive && v.isActive) && <span className="ml-2"><Badge>inactive</Badge></span>}
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        <div>{v.sku}</div>
                        <div className="text-xs text-slate-400">{v.barcodes.map((b) => b.barcode).join(", ")}</div>
                      </td>
                      <td className="px-4 py-3 text-slate-600">{p.category?.name ?? "—"}</td>
                      <td className="num px-4 py-3 text-right">{formatMoney(v.sellPrice)}</td>
                      <td className="num px-4 py-3 text-right">{p.trackStock ? formatQty(v.stockLevel?.onHand ?? 0) : "—"}</td>
                      <td className="px-4 py-3 text-right">
                        <Button variant="ghost" size="sm" aria-label={`Edit ${p.name}`} icon={<Pencil className="size-4" />} onClick={() => setEditing(p)}>
                          Edit
                        </Button>
                      </td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        )}
        {q.data && q.data.total > 25 && (
          <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3 text-sm text-slate-600">
            <span>
              Page {page} of {pages}
            </span>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Prev
              </Button>
              <Button variant="secondary" size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </div>
          </div>
        )}
      </Card>
      {editing && <ProductForm product={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

const numOrNull = (s: string) => (s.trim() === "" ? null : Number(s));

function ProductForm({ product, onClose }: { product: Product | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const categories = useQuery({ queryKey: ["categories"], queryFn: api.categories, staleTime: 60_000 });
  const taxRates = useQuery({ queryKey: ["tax-rates"], queryFn: api.taxRates, staleTime: 60_000 });
  const v0 = product?.variants[0];

  const [name, setName] = useState(product?.name ?? "");
  const [categoryId, setCategoryId] = useState(product?.categoryId ? String(product.categoryId) : "");
  const [taxRateId, setTaxRateId] = useState(product?.taxRateId ? String(product.taxRateId) : "");
  const [unit, setUnit] = useState(product?.unit ?? "pcs");
  const [trackStock, setTrackStock] = useState(product?.trackStock ?? true);
  const [isActive, setIsActive] = useState(product?.isActive ?? true);
  const [sku, setSku] = useState(v0?.sku ?? "");
  const [barcodes, setBarcodes] = useState(v0?.barcodes.map((b) => b.barcode).join(", ") ?? "");
  const [cost, setCost] = useState(v0 ? String(Number(v0.costPrice)) : "0");
  const [sell, setSell] = useState(v0 ? String(Number(v0.sellPrice)) : "");
  const [reorder, setReorder] = useState(v0 ? String(Number(v0.reorderLevel)) : "0");
  const [opening, setOpening] = useState("");
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      const bc = barcodes.split(",").map((b) => b.trim()).filter(Boolean);
      const base = { name: name.trim(), unit: unit.trim() || "pcs", trackStock, categoryId: numOrNull(categoryId), taxRateId: numOrNull(taxRateId) };
      if (!product) {
        return api.createProduct({
          ...base,
          variants: [{ sku: sku.trim(), barcodes: bc, costPrice: Number(cost), sellPrice: Number(sell), reorderLevel: Number(reorder), ...(Number(opening) > 0 ? { openingStock: Number(opening) } : {}) }],
        });
      }
      await api.updateProduct(product.id, { ...base, isActive });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["products"] });
      void qc.invalidateQueries({ queryKey: ["pos-search"] });
      void qc.invalidateQueries({ queryKey: ["inventory"] });
      toast.success(product ? "Product updated" : "Product created");
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const invalid = !name.trim() || (!product && (!sku.trim() || !(Number(sell) >= 0) || sell.trim() === "" || !(Number(cost) >= 0) || !(Number(reorder) >= 0) || (opening !== "" && !(Number(opening) >= 0))));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!invalid) save.mutate();
  };

  return (
    <Modal
      open
      size="xl"
      title={product ? "Edit product" : "New product"}
      onClose={onClose}
      locked={save.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="product-form" loading={save.isPending} disabled={invalid}>
            Save product
          </Button>
        </>
      }
    >
      <form id="product-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        {error && <div className="sm:col-span-2"><Alert>{error}</Alert></div>}
        <Input wrapperClassName="sm:col-span-2" label="Product name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <Select label="Category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">None</option>
          {categories.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Select label="Tax treatment" value={taxRateId} onChange={(e) => setTaxRateId(e.target.value)}>
          <option value="">Default</option>
          {taxRates.data?.filter((t) => t.isActive).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.ratePct}%)
            </option>
          ))}
        </Select>
        {!product && (
          <>
            <Input label="SKU" value={sku} onChange={(e) => setSku(e.target.value)} />
            <Input label="Barcodes" hint="Separate several with commas" value={barcodes} onChange={(e) => setBarcodes(e.target.value)} />
            <Input label="Cost price (Rs.)" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} />
            <Input label="Selling price (Rs.)" inputMode="decimal" value={sell} onChange={(e) => setSell(e.target.value)} />
            <Input label="Reorder level" inputMode="decimal" value={reorder} onChange={(e) => setReorder(e.target.value)} />
          </>
        )}
        <Input label="Unit" value={unit} onChange={(e) => setUnit(e.target.value)} />
        {!product && <Input label="Opening stock" inputMode="decimal" value={opening} onChange={(e) => setOpening(e.target.value)} />}
        <div className="space-y-3 sm:col-span-2">
          <Checkbox label="Track stock" hint="Prevents selling more than is on hand" checked={trackStock} onChange={(e) => setTrackStock(e.target.checked)} />
          {product && <Checkbox label="Active" hint="Inactive products cannot be sold" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />}
        </div>
      </form>
      {product && <VariantsManager productId={product.id} productName={product.name} />}
    </Modal>
  );
}

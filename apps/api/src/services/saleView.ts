import type { Prisma } from "@prisma/client";

export const saleInclude = {
  items: { orderBy: { id: "asc" } },
  payments: { include: { method: true }, orderBy: { id: "asc" } },
  cashier: { select: { id: true, username: true, fullName: true } },
  register: true,
  customer: true,
} satisfies Prisma.SaleInclude;

export type SaleWithRelations = Prisma.SaleGetPayload<{ include: typeof saleInclude }>;

// BigInt ids cannot be JSON-serialised.
export function serializeSale(s: SaleWithRelations) {
  const { requestHash: _hash, ...sale } = s;
  return {
    ...sale,
    items: s.items.map((i) => ({ ...i, id: i.id.toString() })),
    payments: s.payments.map((p) => ({ ...p, id: p.id.toString() })),
  };
}

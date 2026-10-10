import { Prisma, type StockMovementType } from "@prisma/client";
import { prisma } from "../db.js";
import { HttpError } from "../middleware/error.js";

type Tx = Prisma.TransactionClient;

export interface MovementInput {
  variantId: string;
  type: StockMovementType;
  quantity: number; // signed
  unitCost?: number;
  reason?: string;
  referenceType?: string;
  referenceId?: string;
  userId?: string;
}

/**
 * Appends a ledger row and updates the balance atomically.
 * Locks the balance row so concurrent sales cannot oversell.
 */
export async function recordMovement(tx: Tx, input: MovementInput, allowNegative: boolean) {
  const { variantId, quantity } = input;
  if (quantity === 0) throw new HttpError(400, "Quantity cannot be zero");

  await tx.stockLevel.upsert({ where: { variantId }, create: { variantId }, update: {} });
  const rows = await tx.$queryRaw<{ onHand: Prisma.Decimal }[]>`
    SELECT "onHand" FROM "StockLevel" WHERE "variantId" = ${variantId} FOR UPDATE`;
  const next = new Prisma.Decimal(rows[0].onHand).plus(quantity);
  if (next.isNegative() && !allowNegative) throw new HttpError(409, "Insufficient stock");

  await tx.stockLevel.update({ where: { variantId }, data: { onHand: next } });
  return tx.stockMovement.create({
    data: {
      variantId,
      type: input.type,
      quantity,
      unitCost: input.unitCost,
      reason: input.reason,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      createdById: input.userId,
    },
  });
}

export async function getSettings() {
  return prisma.businessSettings.upsert({ where: { id: 1 }, create: {}, update: {} });
}

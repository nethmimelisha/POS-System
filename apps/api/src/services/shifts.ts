import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";

type Db = Prisma.TransactionClient | typeof prisma;
const D = (v: Prisma.Decimal.Value | null | undefined) => new Prisma.Decimal(v ?? 0);

/**
 * Finds the open shift on a register and takes a shared row lock on it, so a concurrent close
 * (which takes an exclusive lock) either waits for this transaction or makes the lookup return null.
 */
export async function lockOpenShift(tx: Prisma.TransactionClient, registerId: number): Promise<number | null> {
  const rows = await tx.$queryRaw<{ id: number }[]>`
    SELECT id FROM "Shift" WHERE "openRegisterId" = ${registerId} FOR SHARE`;
  return rows[0]?.id ?? null;
}

export interface CashSummary {
  openingCash: string;
  cashSales: string; // cash tendered on sales in this shift
  changeGiven: string; // change handed back from the drawer
  netCashSales: string;
  cashIn: string;
  cashOut: string;
  cashRefunds: string; // completed cash refunds only
  expectedCash: string;
  /** Card / online takings are listed for information; they never touch the drawer. */
  nonCashSales: { method: string; amount: string }[];
  nonCashRefunds: { method: string; amount: string; status: string }[];
  salesCount: number;
  returnsCount: number;
}

/** Exact drawer arithmetic. Only cash payment methods count towards expected cash. */
export async function cashSummary(db: Db, shiftId: number): Promise<CashSummary & { _expected: Prisma.Decimal }> {
  const shift = await db.shift.findUniqueOrThrow({ where: { id: shiftId } });

  const pay = await db.$queryRaw<{ code: string; name: string; isCash: boolean; amount: string }[]>`
    SELECT m.code, m.name, m."isCash", COALESCE(SUM(sp.amount), 0)::text AS amount
    FROM "SalePayment" sp
    JOIN "Sale" s ON s.id = sp."saleId"
    JOIN "PaymentMethod" m ON m.id = sp."methodId"
    WHERE s."shiftId" = ${shiftId} AND s.status = 'COMPLETED' AND NOT m."isSystem"
    GROUP BY m.code, m.name, m."isCash"`;
  const [chg] = await db.$queryRaw<{ change: string; n: bigint }[]>`
    SELECT COALESCE(SUM("changeGiven"), 0)::text AS change, COUNT(*) AS n
    FROM "Sale" WHERE "shiftId" = ${shiftId} AND status = 'COMPLETED'`;
  const refunds = await db.$queryRaw<{ code: string; name: string; isCash: boolean; status: string; amount: string }[]>`
    SELECT m.code, m.name, m."isCash", rr.status::text AS status, COALESCE(SUM(rr.amount), 0)::text AS amount
    FROM "ReturnRefund" rr
    JOIN "SaleReturn" r ON r.id = rr."returnId"
    JOIN "PaymentMethod" m ON m.id = rr."methodId"
    WHERE r."shiftId" = ${shiftId} AND NOT m."isSystem"
    GROUP BY m.code, m.name, m."isCash", rr.status`;
  const [ret] = await db.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*) AS n FROM "SaleReturn" WHERE "shiftId" = ${shiftId}`;
  const mv = await db.cashMovement.groupBy({ by: ["type"], where: { shiftId }, _sum: { amount: true } });

  const cashSales = pay.filter((p) => p.isCash).reduce((a, p) => a.plus(p.amount), D(0));
  const change = D(chg.change);
  const cashIn = D(mv.find((m) => m.type === "CASH_IN")?._sum.amount);
  const cashOut = D(mv.find((m) => m.type === "CASH_OUT")?._sum.amount);
  const cashRefunds = refunds.filter((r) => r.isCash && r.status === "COMPLETED").reduce((a, r) => a.plus(r.amount), D(0));
  const netCash = cashSales.minus(change);
  const expected = D(shift.openingCash).plus(netCash).plus(cashIn).minus(cashOut).minus(cashRefunds);

  return {
    openingCash: D(shift.openingCash).toFixed(2),
    cashSales: cashSales.toFixed(2),
    changeGiven: change.toFixed(2),
    netCashSales: netCash.toFixed(2),
    cashIn: cashIn.toFixed(2),
    cashOut: cashOut.toFixed(2),
    cashRefunds: cashRefunds.toFixed(2),
    expectedCash: expected.toFixed(2),
    nonCashSales: pay.filter((p) => !p.isCash).map((p) => ({ method: p.name, amount: D(p.amount).toFixed(2) })),
    nonCashRefunds: refunds
      .filter((r) => !r.isCash)
      .map((r) => ({ method: r.name, amount: D(r.amount).toFixed(2), status: r.status })),
    salesCount: Number(chg.n),
    returnsCount: Number(ret.n),
    _expected: expected,
  };
}

export const shiftInclude = {
  register: true,
  cashier: { select: { id: true, username: true, fullName: true } },
  openedBy: { select: { id: true, fullName: true } },
  closedBy: { select: { id: true, fullName: true } },
  approvedBy: { select: { id: true, fullName: true } },
} satisfies Prisma.ShiftInclude;

export async function shiftView(db: Db, id: number, withMovements = false) {
  const shift = await db.shift.findUniqueOrThrow({
    where: { id },
    include: { ...shiftInclude, ...(withMovements ? { movements: { orderBy: { id: "asc" as const }, include: { createdBy: { select: { fullName: true } } } } } : {}) },
  });
  const { _expected, ...summary } = await cashSummary(db, id);
  const fmt = (v: Prisma.Decimal | null) => (v === null ? null : D(v).toFixed(2));
  return {
    ...shift,
    openingCash: fmt(shift.openingCash),
    expectedCash: fmt(shift.expectedCash),
    countedCash: fmt(shift.countedCash),
    variance: fmt(shift.variance),
    movements: "movements" in shift ? (shift.movements as { amount: Prisma.Decimal }[]).map((m) => ({ ...m, amount: fmt(m.amount) })) : undefined,
    summary,
  };
}

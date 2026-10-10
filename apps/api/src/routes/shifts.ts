import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db.js";
import { asyncHandler, HttpError } from "../middleware/error.js";
import { requireRole } from "../middleware/auth.js";
import { audit } from "../services/audit.js";
import { cashSummary, shiftInclude, shiftView } from "../services/shifts.js";

export const shiftsRouter = Router();
const managerUp = requireRole("ADMIN", "MANAGER");
const isManager = (req: import("express").Request) => req.user!.role !== "CASHIER";

const withinDp2 = (n: number) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
const money = z.number().min(0).max(99_999_999.99).refine(withinDp2, "At most 2 decimal places");
const positiveMoney = money.refine((n) => n > 0, "Amount must be greater than zero");
const idParam = (req: import("express").Request) => {
  const id = z.coerce.number().int().positive().safeParse(req.params.id);
  if (!id.success) throw new HttpError(404, "Shift not found");
  return id.data;
};

/** Cashiers may only touch their own shifts; managers and admins may touch any. */
async function loadShiftFor(req: import("express").Request, id: number) {
  const shift = await prisma.shift.findUnique({ where: { id } });
  if (!shift || (!isManager(req) && shift.cashierId !== req.user!.id)) throw new HttpError(404, "Shift not found");
  return shift;
}

// The caller's own open shift, if any (drives the POS banner).
shiftsRouter.get(
  "/mine",
  asyncHandler(async (req, res) => {
    const open = await prisma.shift.findFirst({ where: { openCashierId: req.user!.id }, select: { id: true } });
    res.json(open ? await shiftView(prisma, open.id) : null);
  }),
);

// The open shift on a register, if any.
shiftsRouter.get(
  "/current",
  asyncHandler(async (req, res) => {
    const { registerId } = z.object({ registerId: z.coerce.number().int().positive() }).parse(req.query);
    const open = await prisma.shift.findUnique({ where: { openRegisterId: registerId }, select: { id: true, cashierId: true } });
    // Cashiers see only their own shift's money; others on the register just learn that it is in use.
    if (!open) return res.json(null);
    if (!isManager(req) && open.cashierId !== req.user!.id) {
      const s = await prisma.shift.findUniqueOrThrow({ where: { id: open.id }, include: shiftInclude });
      return res.json({ ...s, summary: null });
    }
    res.json(await shiftView(prisma, open.id));
  }),
);

shiftsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        registerId: z.coerce.number().int().optional(),
        cashierId: z.string().uuid().optional(),
        status: z.enum(["OPEN", "CLOSED"]).optional(),
        discrepancy: z.enum(["NONE", "PENDING_APPROVAL", "APPROVED"]).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
      })
      .parse(req.query);
    const where: Prisma.ShiftWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.registerId ? { registerId: q.registerId } : {}),
      ...(q.discrepancy ? { discrepancy: q.discrepancy } : {}),
      ...(q.from || q.to ? { openedAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
      ...(isManager(req) ? (q.cashierId ? { cashierId: q.cashierId } : {}) : { cashierId: req.user!.id }),
    };
    const [total, items] = await prisma.$transaction([
      prisma.shift.count({ where }),
      prisma.shift.findMany({
        where,
        include: shiftInclude,
        orderBy: { openedAt: "desc" },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    res.json({ total, page: q.page, pageSize: q.pageSize, items });
  }),
);

shiftsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    await loadShiftFor(req, id);
    res.json(await shiftView(prisma, id, true));
  }),
);

const openInput = z.object({ registerId: z.number().int().positive(), openingCash: money, cashierId: z.string().uuid().optional() }).strict();

shiftsRouter.post(
  "/open",
  asyncHandler(async (req, res) => {
    const input = openInput.parse(req.body);
    const user = req.user!;
    const cashierId = input.cashierId ?? user.id;
    if (!isManager(req) && cashierId !== user.id) throw new HttpError(403, "Only a manager can open a shift for another user");

    const [register, cashier] = await Promise.all([
      prisma.register.findUnique({ where: { id: input.registerId } }),
      prisma.user.findUnique({ where: { id: cashierId } }),
    ]);
    if (!register?.isActive) throw new HttpError(400, "Unknown or inactive register");
    if (!cashier?.isActive) throw new HttpError(400, "Unknown or inactive cashier");

    // The unique openRegisterId / openCashierId columns are the real guard: simultaneous opens cannot both succeed.
    let shift;
    try {
      shift = await prisma.shift.create({
        data: {
          registerId: register.id,
          cashierId,
          openedById: user.id,
          openingCash: input.openingCash.toFixed(2),
          openRegisterId: register.id,
          openCashierId: cashierId,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        const target = String(e.meta?.target ?? "");
        throw new HttpError(
          409,
          target.includes("openCashierId")
            ? `${cashier.fullName} already has an open shift on another register`
            : `${register.name} already has an open shift`,
        );
      }
      throw e;
    }
    await audit(req, "shift.open", "Shift", String(shift.id), {
      registerId: register.id,
      cashierId,
      openingCash: shift.openingCash.toString(),
    });
    res.status(201).json(await shiftView(prisma, shift.id));
  }),
);

const movementInput = z
  .object({ type: z.enum(["CASH_IN", "CASH_OUT"]), amount: positiveMoney, reason: z.string().trim().min(3).max(300) })
  .strict();

shiftsRouter.post(
  "/:id/cash-movements",
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const input = movementInput.parse(req.body);
    await loadShiftFor(req, id);

    const movement = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ status: string }[]>`SELECT status::text FROM "Shift" WHERE id = ${id} FOR UPDATE`;
      if (rows[0]?.status !== "OPEN") throw new HttpError(409, "This shift is closed");
      if (input.type === "CASH_OUT") {
        const { _expected } = await cashSummary(tx, id);
        if (_expected.lessThan(input.amount)) {
          throw new HttpError(409, `Cash out exceeds the cash expected in the drawer (Rs. ${_expected.toFixed(2)})`);
        }
      }
      return tx.cashMovement.create({
        data: { shiftId: id, type: input.type, amount: input.amount.toFixed(2), reason: input.reason, createdById: req.user!.id },
      });
    });
    await audit(req, `shift.${input.type === "CASH_IN" ? "cash_in" : "cash_out"}`, "Shift", String(id), {
      amount: movement.amount.toString(),
      reason: movement.reason,
    });
    res.status(201).json(await shiftView(prisma, id, true));
  }),
);

const closeInput = z.object({ countedCash: money, notes: z.string().trim().max(500).optional() }).strict();

shiftsRouter.post(
  "/:id/close",
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const input = closeInput.parse(req.body);
    await loadShiftFor(req, id);

    const result = await prisma.$transaction(async (tx) => {
      // Exclusive lock: waits for in-flight sales (shared lock) and blocks new ones until we commit.
      const rows = await tx.$queryRaw<{ status: string }[]>`SELECT status::text FROM "Shift" WHERE id = ${id} FOR UPDATE`;
      if (rows[0]?.status !== "OPEN") throw new HttpError(409, "This shift is already closed");
      const { _expected } = await cashSummary(tx, id);
      const counted = new Prisma.Decimal(input.countedCash.toFixed(2));
      const variance = counted.minus(_expected);
      if (!variance.isZero() && !input.notes) throw new HttpError(400, "Notes are required when the count does not match the expected cash");
      await tx.shift.update({
        where: { id },
        data: {
          status: "CLOSED",
          openRegisterId: null,
          openCashierId: null,
          closedAt: new Date(),
          closedById: req.user!.id,
          expectedCash: _expected.toFixed(2),
          countedCash: counted.toFixed(2),
          variance: variance.toFixed(2),
          closingNotes: input.notes,
          discrepancy: variance.isZero() ? "NONE" : "PENDING_APPROVAL",
        },
      });
      return { expected: _expected, variance };
    });
    await audit(req, "shift.close", "Shift", String(id), {
      expectedCash: result.expected.toFixed(2),
      countedCash: input.countedCash.toFixed(2),
      variance: result.variance.toFixed(2),
    });
    res.json(await shiftView(prisma, id, true));
  }),
);

shiftsRouter.post(
  "/:id/approve",
  managerUp,
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const { note } = z.object({ note: z.string().trim().min(3).max(500) }).strict().parse(req.body);
    const shift = await prisma.shift.findUnique({ where: { id } });
    if (!shift) throw new HttpError(404, "Shift not found");
    if (shift.cashierId === req.user!.id) throw new HttpError(403, "A different manager or admin must approve your own shift's discrepancy");
    // Conditional update so two approvers cannot both succeed.
    const done = await prisma.shift.updateMany({
      where: { id, status: "CLOSED", discrepancy: "PENDING_APPROVAL" },
      data: { discrepancy: "APPROVED", approvedById: req.user!.id, approvedAt: new Date(), approvalNote: note },
    });
    if (done.count === 0) throw new HttpError(409, "This shift has no discrepancy awaiting approval");
    await audit(req, "shift.approve_discrepancy", "Shift", String(id), { variance: shift.variance?.toString(), note });
    res.json(await shiftView(prisma, id, true));
  }),
);

import { Router } from "express";
import { prisma } from "../db.js";
import { asyncHandler } from "../middleware/error.js";

// Reference data the POS screen needs before taking a sale.
export const registersRouter = Router();
registersRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json(await prisma.register.findMany({ where: { isActive: true }, orderBy: { name: "asc" } }));
  }),
);

export const paymentMethodsRouter = Router();
paymentMethodsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json(await prisma.paymentMethod.findMany({ where: { isActive: true }, orderBy: { id: "asc" } }));
  }),
);

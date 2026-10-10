import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../db.js";
import { asyncHandler, HttpError } from "../middleware/error.js";
import { requireRole } from "../middleware/auth.js";
import { audit } from "../services/audit.js";

export const usersRouter = Router();
usersRouter.use(requireRole("ADMIN"));

const publicSelect = {
  id: true,
  username: true,
  fullName: true,
  email: true,
  role: true,
  isActive: true,
  lastLoginAt: true,
  createdAt: true,
} as const;

const roleEnum = z.enum(["ADMIN", "MANAGER", "CASHIER"]);

const createSchema = z.object({
  username: z.string().min(3).max(50).regex(/^[a-zA-Z0-9._-]+$/),
  fullName: z.string().min(1).max(100),
  email: z.string().email().optional(),
  password: z.string().min(8).max(128),
  role: roleEnum,
});

const updateSchema = z
  .object({
    fullName: z.string().min(1).max(100),
    email: z.string().email().nullable(),
    password: z.string().min(8).max(128),
    role: roleEnum,
    isActive: z.boolean(),
  })
  .partial();

usersRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json(await prisma.user.findMany({ select: publicSelect, orderBy: { username: "asc" } }));
  }),
);

usersRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const { password, ...data } = createSchema.parse(req.body);
    const user = await prisma.user.create({
      data: { ...data, passwordHash: await bcrypt.hash(password, 10) },
      select: publicSelect,
    });
    await audit(req, "user.create", "User", user.id, { username: user.username, role: user.role });
    res.status(201).json(user);
  }),
);

usersRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const { password, ...data } = updateSchema.parse(req.body);
    if (id === req.user!.id && (data.isActive === false || (data.role && data.role !== "ADMIN"))) {
      throw new HttpError(400, "You cannot deactivate or demote your own account");
    }
    const user = await prisma.user.update({
      where: { id },
      data: { ...data, ...(password ? { passwordHash: await bcrypt.hash(password, 10) } : {}) },
      select: publicSelect,
    });
    // Force re-login when security-relevant fields change.
    if (password || data.isActive === false || data.role) {
      await prisma.session.deleteMany({ where: { userId: id } });
    }
    await audit(req, "user.update", "User", id, { fields: Object.keys(req.body) });
    res.json(user);
  }),
);

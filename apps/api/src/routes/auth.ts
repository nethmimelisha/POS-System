import crypto from "node:crypto";
import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../db.js";
import { config, SESSION_COOKIE, sessionCookieOptions } from "../config.js";
import { loginLimiter } from "../middleware/security.js";
import { asyncHandler, HttpError } from "../middleware/error.js";
import { hashToken, requireAuth } from "../middleware/auth.js";
import { audit } from "../services/audit.js";

export const authRouter = Router();

// Compared against when the user does not exist, to keep timing similar.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);

const loginSchema = z.object({ username: z.string().min(1), password: z.string().min(1) });

authRouter.post(
  "/login",
  loginLimiter,
  asyncHandler(async (req, res) => {
    const { username, password } = loginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { username } });
    const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok || !user.isActive) {
      await audit(req, "auth.login_failed", "User", undefined, { username });
      throw new HttpError(401, "Invalid username or password");
    }

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3600_000);
    await prisma.$transaction([
      prisma.session.create({
        data: {
          tokenHash: hashToken(token),
          userId: user.id,
          expiresAt,
          ip: req.ip,
          userAgent: req.get("user-agent")?.slice(0, 255),
        },
      }),
      prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }),
      prisma.session.deleteMany({ where: { userId: user.id, expiresAt: { lt: new Date() } } }),
    ]);
    req.user = { id: user.id, username: user.username, fullName: user.fullName, role: user.role };
    await audit(req, "auth.login", "User", user.id);

    res.cookie(SESSION_COOKIE, token, sessionCookieOptions(config, expiresAt));
    res.json({ user: req.user });
  }),
);

authRouter.post(
  "/logout",
  asyncHandler(async (req, res) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
    res.clearCookie(SESSION_COOKIE, sessionCookieOptions(config));
    res.json({ ok: true });
  }),
);

authRouter.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(128),
});

authRouter.post(
  "/change-password",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      throw new HttpError(400, "Current password is incorrect");
    }
    const current = hashToken(req.cookies[SESSION_COOKIE]);
    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(newPassword, 10) } }),
      // Sign out all other sessions.
      prisma.session.deleteMany({ where: { userId: user.id, NOT: { tokenHash: current } } }),
    ]);
    await audit(req, "auth.password_changed", "User", user.id);
    res.json({ ok: true });
  }),
);

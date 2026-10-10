import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { Role, User } from "@prisma/client";
import { prisma } from "../db.js";
import { SESSION_COOKIE } from "../config.js";
import { HttpError } from "./error.js";

export type AuthUser = Pick<User, "id" | "username" | "fullName" | "role">;

declare module "express-serve-static-core" {
  interface Request {
    user?: AuthUser;
  }
}

export const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) throw new HttpError(401, "Not authenticated");
    const session = await prisma.session.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: true },
    });
    if (!session || session.expiresAt < new Date() || !session.user.isActive) {
      throw new HttpError(401, "Session expired");
    }
    const { id, username, fullName, role } = session.user;
    req.user = { id, username, fullName, role };
    next();
  } catch (e) {
    next(e);
  }
}

export const requireRole =
  (...roles: Role[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) return next(new HttpError(403, "Forbidden"));
    next();
  };

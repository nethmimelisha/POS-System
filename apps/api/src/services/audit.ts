import type { Request } from "express";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";

export function audit(
  req: Request,
  action: string,
  entityType?: string,
  entityId?: string,
  details?: Prisma.InputJsonValue,
) {
  return prisma.auditLog.create({
    data: { userId: req.user?.id, action, entityType, entityId, details, ip: req.ip },
  });
}

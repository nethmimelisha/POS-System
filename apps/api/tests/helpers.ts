import { randomUUID } from "node:crypto";
import request from "supertest";
import bcrypt from "bcryptjs";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db.js";

export const app = createApp();
export const base = "/api/v1";
export type Agent = ReturnType<typeof request.agent>;
export const PASSWORD = "SprintFour123!";

export async function login(username: string, password: string): Promise<Agent> {
  const agent = request.agent(app);
  await agent.post(`${base}/auth/login`).send({ username, password }).expect(200);
  return agent;
}

export async function makeUser(username: string, role: "ADMIN" | "MANAGER" | "CASHIER") {
  const user = await prisma.user.create({
    data: { username, fullName: username.replace(/_/g, " "), role, passwordHash: await bcrypt.hash(PASSWORD, 4) },
  });
  return { user, agent: await login(username, PASSWORD) };
}

export async function makeRegister(name: string) {
  return prisma.register.create({ data: { name } });
}

export async function makeProduct(admin: Agent, name: string, sku: string, price: number, stock = 100, opts: Record<string, unknown> = {}) {
  const res = await admin
    .post(`${base}/products`)
    .send({ name, ...opts, variants: [{ sku, sellPrice: price, costPrice: price / 2, openingStock: stock }] })
    .expect(201);
  return res.body.variants[0].id as string;
}

export const onHand = async (variantId: string) => Number((await prisma.stockLevel.findUnique({ where: { variantId } }))?.onHand ?? 0);

export const saleBody = (registerId: number, items: { variantId: string; quantity: number }[], payments: object[], extra: object = {}) => ({
  id: randomUUID(),
  registerId,
  items,
  payments,
  ...extra,
});

export async function setSettings(data: Record<string, unknown>) {
  await prisma.businessSettings.upsert({ where: { id: 1 }, create: data, update: data });
}

export async function closeAllShifts() {
  await prisma.shift.updateMany({ where: { status: "OPEN" }, data: { status: "CLOSED", openRegisterId: null, openCashierId: null, closedAt: new Date() } });
}

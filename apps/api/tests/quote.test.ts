import request from "supertest";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db.js";

const app = createApp();
const base = "/api/v1";
type Agent = ReturnType<typeof request.agent>;

async function login(username: string, password: string): Promise<Agent> {
  const agent = request.agent(app);
  await agent.post(`${base}/auth/login`).send({ username, password }).expect(200);
  return agent;
}

describe("POST /sales/quote", () => {
  let admin: Agent;
  let cashier: Agent;
  let variantId: string;

  beforeAll(async () => {
    await prisma.businessSettings.update({ where: { id: 1 }, data: { taxEnabled: false, allowNegativeStock: false } });
    admin = await login("admin", "TestPass123!");
    await prisma.user.create({
      data: { username: "quote_cashier", fullName: "Q", role: "CASHIER", passwordHash: await bcrypt.hash("QuotePass123!", 4) },
    });
    cashier = await login("quote_cashier", "QuotePass123!");
    const res = await admin
      .post(`${base}/products`)
      .send({ name: "Quote Item", variants: [{ sku: "Q-ITEM", sellPrice: 200, costPrice: 100, openingStock: 3 }] })
      .expect(201);
    variantId = res.body.variants[0].id;
  });

  it("prices a cart on the server without creating a sale or moving stock", async () => {
    const sales = await prisma.sale.count();
    const res = await cashier
      .post(`${base}/sales/quote`)
      .send({ items: [{ variantId, quantity: 2, discount: { type: "PERCENT", value: 5 } }], discount: { type: "AMOUNT", value: 10 } })
      .expect(200);
    expect(res.body).toMatchObject({ subtotal: "400.00", discountTotal: "30.00", taxTotal: "0.00", grandTotal: "370.00", canCheckout: true });
    expect(res.body.lines[0]).toMatchObject({ sku: "Q-ITEM", unitPrice: "200.00", lineTotal: "370.00", onHand: 3, insufficientStock: false });
    expect(await prisma.sale.count()).toBe(sales);
    expect(Number((await prisma.stockLevel.findUniqueOrThrow({ where: { variantId } })).onHand)).toBe(3);
  });

  it("flags insufficient stock using the combined quantity of repeated lines", async () => {
    const res = await cashier
      .post(`${base}/sales/quote`)
      .send({ items: [{ variantId, quantity: 2 }, { variantId, quantity: 2 }] })
      .expect(200);
    expect(res.body.canCheckout).toBe(false);
    expect(res.body.lines.every((l: { insufficientStock: boolean }) => l.insufficientStock)).toBe(true);
  });

  it("applies the same discount authorisation as checkout", async () => {
    const body = { items: [{ variantId, quantity: 1 }], discount: { type: "PERCENT", value: 20 } };
    const res = await cashier.post(`${base}/sales/quote`).send(body).expect(403);
    expect(res.body.error).toMatch(/manager approval/);
    await admin.post(`${base}/sales/quote`).send(body).expect(200);
    await admin
      .post(`${base}/sales/quote`)
      .send({ items: [{ variantId, quantity: 1 }], discount: { type: "AMOUNT", value: 500 } })
      .expect(400);
  });

  it("validates input and requires authentication", async () => {
    await cashier.post(`${base}/sales/quote`).send({ items: [] }).expect(400);
    await cashier.post(`${base}/sales/quote`).send({ items: [{ variantId, quantity: 1, unitPrice: 1 }] }).expect(400);
    await cashier.post(`${base}/sales/quote`).send({ items: [{ variantId: randomUUID(), quantity: 1 }] }).expect(400);
    await request(app).post(`${base}/sales/quote`).send({ items: [{ variantId, quantity: 1 }] }).expect(401);
  });
});

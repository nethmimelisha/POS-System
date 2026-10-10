import request from "supertest";
import bcrypt from "bcryptjs";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db.js";

const app = createApp();
const base = "/api/v1";

async function login(username: string, password: string) {
  const agent = request.agent(app);
  const res = await agent.post(`${base}/auth/login`).send({ username, password });
  return { agent, res };
}

describe("POS API", () => {
  let admin: request.Agent;
  let cashier: request.Agent;
  let variantId: string;

  beforeAll(async () => {
    admin = (await login("admin", "TestPass123!")).agent;
    await prisma.user.create({
      data: { username: "cash1", fullName: "Cashier", role: "CASHIER", passwordHash: await bcrypt.hash("CashPass123!", 4) },
    });
    cashier = (await login("cash1", "CashPass123!")).agent;
  });

  it("health works", async () => {
    await request(app).get("/health").expect(200);
  });

  it("rejects unauthenticated and bad logins", async () => {
    await request(app).get(`${base}/products`).expect(401);
    const { res } = await login("admin", "wrong");
    expect(res.status).toBe(401);
  });

  it("sets httpOnly cookie and returns current user", async () => {
    const { res } = await login("admin", "TestPass123!");
    expect(res.headers["set-cookie"][0]).toMatch(/HttpOnly/i);
    const me = await admin.get(`${base}/auth/me`).expect(200);
    expect(me.body.user.role).toBe("ADMIN");
    expect(JSON.stringify(me.body)).not.toMatch(/passwordHash/);
  });

  it("enforces RBAC", async () => {
    await cashier.get(`${base}/users`).expect(403);
    await cashier.post(`${base}/products`).send({}).expect(403);
    await cashier.get(`${base}/products`).expect(200);
  });

  it("manages users (admin)", async () => {
    const created = await admin
      .post(`${base}/users`)
      .send({ username: "mgr1", fullName: "Manager", password: "ManagerPass1", role: "MANAGER" })
      .expect(201);
    expect(created.body.passwordHash).toBeUndefined();
    await admin
      .post(`${base}/users`)
      .send({ username: "mgr1", fullName: "Dup", password: "ManagerPass1", role: "MANAGER" })
      .expect(409);
    const me = await admin.get(`${base}/auth/me`);
    await admin.patch(`${base}/users/${me.body.user.id}`).send({ isActive: false }).expect(400);
  });

  it("creates product with variant, barcode and opening stock", async () => {
    const res = await admin
      .post(`${base}/products`)
      .send({
        name: "Basmati Rice 1kg",
        unit: "pack",
        variants: [{ sku: "RICE-1KG", sellPrice: 450, costPrice: 380, reorderLevel: 5, barcodes: ["4791234567890"], openingStock: 10 }],
      })
      .expect(201);
    variantId = res.body.variants[0].id;
    expect(Number(res.body.variants[0].stockLevel.onHand)).toBe(10);
  });

  it("rejects duplicate SKU and barcode", async () => {
    await admin
      .post(`${base}/products`)
      .send({ name: "Dup", variants: [{ sku: "RICE-1KG", sellPrice: 1 }] })
      .expect(409);
    await admin
      .post(`${base}/products`)
      .send({ name: "Dup2", variants: [{ sku: "OTHER", sellPrice: 1, barcodes: ["4791234567890"] }] })
      .expect(409);
    const leftover = await prisma.product.count({ where: { name: { in: ["Dup", "Dup2"] } } });
    expect(leftover).toBe(0);
  });

  it("looks up by barcode and searches by name", async () => {
    const hit = await cashier.get(`${base}/products/lookup/4791234567890`).expect(200);
    expect(hit.body.sku).toBe("RICE-1KG");
    await cashier.get(`${base}/products/lookup/000`).expect(404);
    const search = await cashier.get(`${base}/products?search=basmati`).expect(200);
    expect(search.body.total).toBe(1);
  });

  it("adjusts stock via ledger and blocks negative stock", async () => {
    const r = await admin
      .post(`${base}/inventory/adjustments`)
      .send({ variantId, type: "DAMAGE", quantity: 3, reason: "Broken packs" })
      .expect(201);
    expect(Number(r.body.onHand)).toBe(7);
    await admin
      .post(`${base}/inventory/adjustments`)
      .send({ variantId, type: "ADJUSTMENT", quantity: -100, reason: "Count" })
      .expect(409);
    const low = await admin.get(`${base}/inventory/levels?lowOnly=true`).expect(200);
    expect(low.body.filter((r: { variantId: string }) => r.variantId === variantId)).toHaveLength(0);
    await admin.post(`${base}/inventory/adjustments`).send({ variantId, type: "ADJUSTMENT", quantity: -3, reason: "Count" }).expect(201);
    const low2 = await admin.get(`${base}/inventory/levels?lowOnly=true`).expect(200);
    expect(low2.body.filter((r: { variantId: string }) => r.variantId === variantId)).toHaveLength(1);
  });

  it("keeps ledger and balance consistent under concurrency", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        admin.post(`${base}/inventory/adjustments`).send({ variantId, type: "ADJUSTMENT", quantity: -1, reason: "race" }),
      ),
    );
    const ok = results.filter((r) => r.status === 201).length;
    const level = await prisma.stockLevel.findUniqueOrThrow({ where: { variantId } });
    const sum = await prisma.stockMovement.aggregate({ where: { variantId }, _sum: { quantity: true } });
    expect(Number(level.onHand)).toBe(Number(sum._sum.quantity));
    expect(Number(level.onHand)).toBeGreaterThanOrEqual(0);
    expect(ok).toBe(4); // 4 units were on hand
  });

  it("validates tax rates and settings", async () => {
    await admin.post(`${base}/tax-rates`).send({ name: "Bad", type: "ZERO_RATED", ratePct: 5 }).expect(400);
    const s = await admin.get(`${base}/settings`).expect(200);
    expect(s.body.taxEnabled).toBe(false);
    expect(s.body.currencyCode).toBe("LKR");
    await cashier.put(`${base}/settings`).send({ taxEnabled: true }).expect(403);
    await admin.put(`${base}/settings`).send({ taxEnabled: true }).expect(200);
  });

  it("logout invalidates the session", async () => {
    const { agent } = await login("cash1", "CashPass123!");
    await agent.post(`${base}/auth/logout`).expect(200);
    await agent.get(`${base}/auth/me`).expect(401);
  });
});

import { randomUUID } from "node:crypto";
import request from "supertest";
import bcrypt from "bcryptjs";
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

describe("Sales & checkout", () => {
  let admin: Agent;
  let cashier: Agent;
  let cashier2: Agent;
  let manager: Agent;
  let registerId: number;
  let cashierId: string;

  // variant ids
  let plain: string; // Rs 100, stock 100
  let pricey: string; // Rs 250.50, stock 5
  let taxed: string; // Rs 118, standard VAT
  let zeroRated: string; // Rs 100, zero-rated VAT
  let untracked: string; // Rs 50, no stock tracking

  const onHand = async (variantId: string) =>
    Number((await prisma.stockLevel.findUnique({ where: { variantId } }))?.onHand ?? 0);
  const setTax = (taxEnabled: boolean, pricesIncludeTax = true) =>
    prisma.businessSettings.update({ where: { id: 1 }, data: { taxEnabled, pricesIncludeTax } });

  const sale = (over: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    registerId,
    items: [{ variantId: plain, quantity: 1 }],
    payments: [{ method: "cash", amount: 100 }],
    ...over,
  });
  const post = (agent: Agent, body: unknown) => agent.post(`${base}/sales`).send(body as object);

  async function makeProduct(name: string, sku: string, price: number, opts: Record<string, unknown> = {}, stock?: number) {
    const res = await admin
      .post(`${base}/products`)
      .send({ name, ...opts, variants: [{ sku, sellPrice: price, costPrice: price / 2, openingStock: stock }] })
      .expect(201);
    return res.body.variants[0].id as string;
  }

  beforeAll(async () => {
    await prisma.businessSettings.update({
      where: { id: 1 },
      data: { taxEnabled: false, pricesIncludeTax: true, allowNegativeStock: false },
    });
    admin = await login("admin", "TestPass123!");
    for (const [username, role] of [
      ["sale_cashier", "CASHIER"],
      ["sale_cashier2", "CASHIER"],
      ["sale_manager", "MANAGER"],
    ] as const) {
      await prisma.user.create({
        data: { username, fullName: username, role, passwordHash: await bcrypt.hash("SalePass123!", 4) },
      });
    }
    cashier = await login("sale_cashier", "SalePass123!");
    cashier2 = await login("sale_cashier2", "SalePass123!");
    manager = await login("sale_manager", "SalePass123!");
    cashierId = (await cashier.get(`${base}/auth/me`)).body.user.id;
    registerId = (await prisma.register.findFirstOrThrow({ orderBy: { id: "asc" } })).id;

    const vat = await prisma.taxRate.findUniqueOrThrow({ where: { name: "VAT 18%" } });
    const zero = await prisma.taxRate.findUniqueOrThrow({ where: { name: "Zero-rated" } });
    plain = await makeProduct("Sale Plain", "S-PLAIN", 100, {}, 100);
    pricey = await makeProduct("Sale Pricey", "S-PRICEY", 250.5, {}, 5);
    taxed = await makeProduct("Sale Taxed", "S-TAXED", 118, { taxRateId: vat.id }, 100);
    zeroRated = await makeProduct("Sale Zero", "S-ZERO", 100, { taxRateId: zero.id }, 100);
    untracked = await makeProduct("Sale Service", "S-SERVICE", 50, { trackStock: false });
  });

  describe("successful checkout", () => {
    it("completes a cash sale, deducts stock, tracks cashier and register", async () => {
      const before = await onHand(plain);
      const body = sale({ items: [{ variantId: plain, quantity: 2 }], payments: [{ method: "cash", amount: 500 }] });
      const res = await post(cashier, body).expect(201);

      expect(res.headers["idempotent-replay"]).toBe("false");
      expect(res.body.saleNumber).toMatch(/^INV-\d{6}$/);
      expect(res.body.status).toBe("COMPLETED");
      expect(res.body.cashierId).toBe(cashierId);
      expect(res.body.registerId).toBe(registerId);
      expect(Number(res.body.grandTotal)).toBe(200);
      expect(Number(res.body.amountPaid)).toBe(500);
      expect(Number(res.body.changeGiven)).toBe(300);
      expect(Number(res.body.taxTotal)).toBe(0);
      expect(res.body.requestHash).toBeUndefined();
      expect(res.body.items[0]).toMatchObject({ sku: "S-PLAIN", description: "Sale Plain" });
      expect(Number(res.body.items[0].unitPrice)).toBe(100);

      expect(await onHand(plain)).toBe(before - 2);
      const movement = await prisma.stockMovement.findFirstOrThrow({ where: { referenceId: res.body.id } });
      expect(movement.type).toBe("SALE");
      expect(Number(movement.quantity)).toBe(-2);
    });

    it("does not touch stock for untracked items", async () => {
      const res = await post(cashier, sale({ items: [{ variantId: untracked, quantity: 3 }], payments: [{ method: "cash", amount: 150 }] })).expect(201);
      expect(Number(res.body.grandTotal)).toBe(150);
      expect(await prisma.stockMovement.count({ where: { variantId: untracked } })).toBe(0);
    });

    it("prices on the server: client-supplied prices are rejected", async () => {
      const body = sale({ items: [{ variantId: plain, quantity: 1, unitPrice: 1 }] });
      await post(cashier, body).expect(400);
      await post(cashier, sale({ grandTotal: 1 })).expect(400);
    });

    it("applies line and cart discounts", async () => {
      const res = await post(
        cashier,
        sale({
          items: [{ variantId: plain, quantity: 3, discount: { type: "PERCENT", value: 5 } }],
          discount: { type: "AMOUNT", value: 5 },
          payments: [{ method: "card", amount: 280, reference: "AUTH-1" }],
        }),
      ).expect(201);
      // 300 - 15 (5%) - 5 = 280
      expect(Number(res.body.subtotal)).toBe(300);
      expect(Number(res.body.discountTotal)).toBe(20);
      expect(Number(res.body.grandTotal)).toBe(280);
      expect(Number(res.body.changeGiven)).toBe(0);
    });

    it("caps cashier discounts but lets managers exceed them", async () => {
      const body = () => sale({ discount: { type: "PERCENT", value: 20 }, payments: [{ method: "cash", amount: 80 }] });
      const denied = await post(cashier, body()).expect(403);
      expect(denied.body.error).toMatch(/manager approval/);
      await post(manager, body()).expect(201);
      await post(manager, sale({ discount: { type: "AMOUNT", value: 500 } })).expect(400);
    });

    it("accepts split payments across methods with change from cash", async () => {
      const res = await post(
        cashier,
        sale({
          items: [{ variantId: pricey, quantity: 1 }],
          payments: [
            { method: "card", amount: 100, reference: "AUTH-2" },
            { method: "online", amount: 100, reference: "TXN-9" },
            { method: "cash", amount: 100 },
          ],
        }),
      ).expect(201);
      expect(Number(res.body.grandTotal)).toBe(250.5);
      expect(Number(res.body.changeGiven)).toBe(49.5);
      expect(res.body.payments.map((p: { method: { code: string } }) => p.method.code)).toEqual(["card", "online", "cash"]);
    });
  });

  describe("VAT", () => {
    it("is disabled by default: taxed products carry no VAT", async () => {
      const res = await post(cashier, sale({ items: [{ variantId: taxed, quantity: 1 }], payments: [{ method: "cash", amount: 118 }] })).expect(201);
      expect(Number(res.body.taxTotal)).toBe(0);
      expect(Number(res.body.grandTotal)).toBe(118);
    });

    it("extracts VAT from inclusive prices when enabled, skipping zero-rated items", async () => {
      await setTax(true, true);
      try {
        const res = await post(
          cashier,
          sale({
            items: [
              { variantId: taxed, quantity: 1 },
              { variantId: zeroRated, quantity: 1 },
            ],
            payments: [{ method: "cash", amount: 218 }],
          }),
        ).expect(201);
        expect(Number(res.body.taxTotal)).toBe(18);
        expect(Number(res.body.grandTotal)).toBe(218);
        const receipt = await cashier.get(`${base}/sales/${res.body.id}/receipt`).expect(200);
        expect(receipt.body.tax.note).toBe("Prices include VAT");
        expect(receipt.body.tax.breakdown[0]).toMatchObject({ ratePct: 18, taxAmount: "Rs. 18.00", taxableAmount: "Rs. 100.00" });
      } finally {
        await setTax(false);
      }
    });

    it("adds VAT to exclusive prices when enabled", async () => {
      await setTax(true, false);
      try {
        const res = await post(cashier, sale({ items: [{ variantId: taxed, quantity: 1 }], payments: [{ method: "cash", amount: 139.24 }] })).expect(201);
        expect(Number(res.body.taxTotal)).toBe(21.24);
        expect(Number(res.body.grandTotal)).toBe(139.24);
      } finally {
        await setTax(false);
      }
    });
  });

  describe("receipt and retrieval", () => {
    it("builds formatted receipt data", async () => {
      const created = await post(cashier, sale({ items: [{ variantId: pricey, quantity: 2 }], payments: [{ method: "card", amount: 501, reference: "AUTH-R" }] })).expect(201);
      const r = (await cashier.get(`${base}/sales/${created.body.id}/receipt`).expect(200)).body;
      expect(r.invoiceNumber).toBe(created.body.saleNumber);
      expect(r.currency).toEqual({ code: "LKR", symbol: "Rs." });
      expect(r.items[0]).toMatchObject({ description: "Sale Pricey", quantity: 2, unitPrice: "Rs. 250.50", lineTotal: "Rs. 501.00" });
      expect(r.totals).toMatchObject({ grandTotal: "Rs. 501.00", paid: "Rs. 501.00", change: "Rs. 0.00", tax: null });
      expect(r.tax).toBeNull();
      expect(r.payments[0]).toMatchObject({ method: "Card", reference: "AUTH-R" });
      expect(r.register).toBeTruthy();
    });

    it("limits cashiers to their own sales, managers see all", async () => {
      const created = await post(cashier, sale()).expect(201);
      await cashier.get(`${base}/sales/${created.body.id}`).expect(200);
      await cashier2.get(`${base}/sales/${created.body.id}`).expect(404);
      await cashier2.get(`${base}/sales/${created.body.id}/receipt`).expect(404);
      await manager.get(`${base}/sales/${created.body.id}`).expect(200);
      await request(app).get(`${base}/sales/${created.body.id}`).expect(401);

      const own = await cashier2.get(`${base}/sales`).expect(200);
      expect(own.body.total).toBe(0);
      const all = await manager.get(`${base}/sales?pageSize=2`).expect(200);
      expect(all.body.total).toBeGreaterThan(2);
      expect(all.body.items).toHaveLength(2);
      const filtered = await manager.get(`${base}/sales?cashierId=${cashierId}`).expect(200);
      expect(filtered.body.items.every((s: { cashier: { id: string } }) => s.cashier.id === cashierId)).toBe(true);
    });

    it("writes an audit entry per sale", async () => {
      const created = await post(cashier, sale()).expect(201);
      const logs = await prisma.auditLog.findMany({ where: { action: "sale.create", entityId: created.body.id } });
      expect(logs).toHaveLength(1);
      expect(logs[0].userId).toBe(cashierId);
    });

    it("lists active registers and payment methods", async () => {
      expect((await cashier.get(`${base}/registers`).expect(200)).body.length).toBeGreaterThan(0);
      const methods = (await cashier.get(`${base}/payment-methods`).expect(200)).body;
      expect(methods.map((m: { code: string }) => m.code)).toEqual(expect.arrayContaining(["cash", "card", "online"]));
    });
  });

  describe("validation", () => {
    it("rejects unknown register, customer, item and inactive items", async () => {
      await post(cashier, sale({ registerId: 99999 })).expect(400);
      await post(cashier, sale({ customerId: randomUUID() })).expect(400);
      await post(cashier, sale({ items: [{ variantId: randomUUID(), quantity: 1 }] })).expect(400);
      await post(cashier, sale({ items: [] })).expect(400);
      await post(cashier, sale({ items: [{ variantId: plain, quantity: 0 }] })).expect(400);
      await post(cashier, sale({ items: [{ variantId: plain, quantity: 1.0005 }] })).expect(400);

      const inactive = await makeProduct("Sale Inactive", "S-INACTIVE", 10, {}, 5);
      await prisma.productVariant.update({ where: { id: inactive }, data: { isActive: false } });
      await post(cashier, sale({ items: [{ variantId: inactive, quantity: 1 }] })).expect(409);
      await request(app).post(`${base}/sales`).send(sale()).expect(401);
    });
  });

  describe("payment failures", () => {
    const failing = async (payments: unknown[], status: number, pattern: RegExp) => {
      const stockBefore = await onHand(plain);
      const count = await prisma.sale.count();
      const body = sale({ payments });
      const res = await post(cashier, body).expect(status);
      expect(res.body.error).toMatch(pattern);
      // Nothing may persist from a rejected payment, and the same id remains usable.
      expect(await onHand(plain)).toBe(stockBefore);
      expect(await prisma.sale.count()).toBe(count);
      expect(await prisma.sale.findUnique({ where: { id: body.id } })).toBeNull();
    };

    it("rejects underpayment with 402", () => failing([{ method: "cash", amount: 99.99 }], 402, /Insufficient payment: Rs\. 0\.01/));
    it("requires a reference for card and online payments", () => failing([{ method: "card", amount: 100 }], 400, /reference is required/));
    it("rejects card/online overpayment", () => failing([{ method: "card", amount: 150, reference: "X" }], 400, /cannot exceed/));
    it("rejects unknown payment methods", () => failing([{ method: "bitcoin", amount: 100 }], 400, /payment method/));

    it("rejects inactive payment methods", async () => {
      await prisma.paymentMethod.update({ where: { code: "online" }, data: { isActive: false } });
      try {
        await failing([{ method: "online", amount: 100, reference: "T" }], 400, /inactive payment method/);
      } finally {
        await prisma.paymentMethod.update({ where: { code: "online" }, data: { isActive: true } });
      }
    });

    it("allows a retry with the same id after a payment failure", async () => {
      const id = randomUUID();
      await post(cashier, sale({ id, payments: [{ method: "cash", amount: 10 }] })).expect(402);
      await post(cashier, sale({ id, payments: [{ method: "cash", amount: 100 }] })).expect(201);
    });
  });

  describe("stock and rollback", () => {
    it("rejects insufficient stock without side effects", async () => {
      const stock = await onHand(pricey);
      const count = await prisma.sale.count();
      const res = await post(cashier, sale({ items: [{ variantId: pricey, quantity: stock + 1 }], payments: [{ method: "cash", amount: 99999 }] })).expect(409);
      expect(res.body.error).toBe("Insufficient stock for S-PRICEY");
      expect(await onHand(pricey)).toBe(stock);
      expect(await prisma.sale.count()).toBe(count);
    });

    it("rolls back every line when one line lacks stock", async () => {
      const okVariant = await makeProduct("Sale Rollback A", "S-RB-A", 10, {}, 10);
      const shortVariant = await makeProduct("Sale Rollback B", "S-RB-B", 10, {}, 1);
      const movements = await prisma.stockMovement.count();
      await post(
        cashier,
        sale({
          items: [
            { variantId: okVariant, quantity: 4 },
            { variantId: shortVariant, quantity: 2 },
          ],
          payments: [{ method: "cash", amount: 60 }],
        }),
      ).expect(409);
      expect(await onHand(okVariant)).toBe(10);
      expect(await onHand(shortVariant)).toBe(1);
      expect(await prisma.stockMovement.count()).toBe(movements);
    });

    it("sums repeated lines of the same item when checking stock", async () => {
      const v = await makeProduct("Sale Repeat", "S-REPEAT", 10, {}, 3);
      await post(
        cashier,
        sale({
          items: [
            { variantId: v, quantity: 2 },
            { variantId: v, quantity: 2 },
          ],
          payments: [{ method: "cash", amount: 40 }],
        }),
      ).expect(409);
      expect(await onHand(v)).toBe(3);
    });

    it("rolls back stock and the invoice counter when the sale insert fails", async () => {
      const v = await makeProduct("Sale Rollback C", "S-RB-C", 10, {}, 10);
      const counter = (await prisma.documentCounter.findUniqueOrThrow({ where: { key: "sale" } })).value;
      const nextNumber = `INV-${String(counter + 1).padStart(6, "0")}`;
      const adminId = (await prisma.user.findUniqueOrThrow({ where: { username: "admin" } })).id;
      // Occupying the next invoice number makes the final insert fail after stock was deducted.
      const blocker = await prisma.sale.create({ data: { id: randomUUID(), saleNumber: nextNumber, cashierId: adminId } });

      const body = sale({ items: [{ variantId: v, quantity: 4 }], payments: [{ method: "cash", amount: 40 }] });
      await post(cashier, body).expect(409);
      expect(await onHand(v)).toBe(10);
      expect(await prisma.stockMovement.count({ where: { variantId: v, type: "SALE" } })).toBe(0);
      expect((await prisma.documentCounter.findUniqueOrThrow({ where: { key: "sale" } })).value).toBe(counter);
      expect(await prisma.sale.findUnique({ where: { id: body.id } })).toBeNull();

      await prisma.sale.delete({ where: { id: blocker.id } });
      const retry = await post(cashier, body).expect(201);
      expect(retry.body.saleNumber).toBe(nextNumber);
      expect(await onHand(v)).toBe(6);
    });
  });

  describe("concurrency and idempotency", () => {
    it("never oversells and issues unique invoice numbers under concurrent sales", async () => {
      const v = await makeProduct("Sale Race", "S-RACE", 10, {}, 5);
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          post(i % 2 ? cashier : cashier2, sale({ items: [{ variantId: v, quantity: 1 }], payments: [{ method: "cash", amount: 10 }] })),
        ),
      );
      const ok = results.filter((r) => r.status === 201);
      const rejected = results.filter((r) => r.status === 409);
      expect(ok).toHaveLength(5);
      expect(rejected).toHaveLength(5);
      expect(await onHand(v)).toBe(0);
      const numbers = ok.map((r) => r.body.saleNumber);
      expect(new Set(numbers).size).toBe(5);
      const ledger = await prisma.stockMovement.aggregate({ where: { variantId: v, type: "SALE" }, _sum: { quantity: true } });
      expect(Number(ledger._sum.quantity)).toBe(-5);
    });

    it("issues gapless invoice numbers across failures", async () => {
      const a = await post(cashier, sale()).expect(201);
      await post(cashier, sale({ payments: [{ method: "cash", amount: 1 }] })).expect(402);
      const b = await post(cashier, sale()).expect(201);
      const n = (s: string) => Number(s.slice(4));
      expect(n(b.body.saleNumber)).toBe(n(a.body.saleNumber) + 1);
    });

    it("replays a duplicate request without selling twice", async () => {
      const before = await onHand(plain);
      const body = sale({ items: [{ variantId: plain, quantity: 2 }], payments: [{ method: "cash", amount: 200 }] });
      const first = await post(cashier, body).expect(201);
      const second = await post(cashier, body).expect(200);
      expect(second.headers["idempotent-replay"]).toBe("true");
      expect(second.body.id).toBe(first.body.id);
      expect(second.body.saleNumber).toBe(first.body.saleNumber);
      expect(await onHand(plain)).toBe(before - 2);
      expect(await prisma.auditLog.count({ where: { action: "sale.create", entityId: body.id } })).toBe(1);
    });

    it("rejects a reused id with a different payload or from another cashier", async () => {
      const body = sale();
      await post(cashier, body).expect(201);
      await post(cashier, { ...body, notes: "changed" }).expect(409);
      await post(cashier2, body).expect(409);
    });

    it("handles simultaneous duplicate submissions as a single sale", async () => {
      const before = await onHand(plain);
      const body = sale({ items: [{ variantId: plain, quantity: 1 }] });
      const results = await Promise.all(Array.from({ length: 6 }, () => post(cashier, body)));
      expect(results.every((r) => r.status === 201 || r.status === 200)).toBe(true);
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(new Set(results.map((r) => r.body.saleNumber)).size).toBe(1);
      expect(await prisma.sale.count({ where: { id: body.id } })).toBe(1);
      expect(await onHand(plain)).toBe(before - 1);
    });
  });
});

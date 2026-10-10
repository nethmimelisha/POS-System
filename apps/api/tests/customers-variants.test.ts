import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { type Agent, base, closeAllShifts, login, makeProduct, makeRegister, makeUser, onHand, saleBody, setSettings } from "./helpers.js";

describe("Customers", () => {
  let admin: Agent;
  let manager: Agent;
  let cashier: Agent;
  let registerId: number;
  let item: string;

  beforeAll(async () => {
    await closeAllShifts();
    await setSettings({ taxEnabled: false, requireShift: false, allowNegativeStock: false });
    admin = await login("admin", "TestPass123!");
    manager = (await makeUser("cust_manager", "MANAGER")).agent;
    cashier = (await makeUser("cust_cashier", "CASHIER")).agent;
    registerId = (await makeRegister("Customer Register")).id;
    item = await makeProduct(admin, "Cust Item", "CUST-1", 100, 500);
  });

  it("creates, edits and searches customers", async () => {
    const created = await cashier.post(`${base}/customers`).send({ name: "Nimali Perera", phone: "0771234567", email: "nimali@example.lk" }).expect(201);
    const id = created.body.id as string;
    await cashier.patch(`${base}/customers/${id}`).send({ notes: "Prefers email receipts" }).expect(200);
    const byName = await cashier.get(`${base}/customers?search=nimali`).expect(200);
    expect(byName.body.items.map((c: { id: string }) => c.id)).toContain(id);
    expect((await cashier.get(`${base}/customers?search=0771234567`).expect(200)).body.items.map((c: { id: string }) => c.id)).toContain(id);
    expect((await cashier.get(`${base}/customers/${id}`).expect(200)).body.notes).toBe("Prefers email receipts");
    expect((await cashier.post(`${base}/customers`).send({ name: "" })).status).toBe(400);
    expect((await cashier.get(`${base}/customers/${randomUUID()}`)).status).toBe(404);
  });

  it("links customers to sales optionally and shows purchase history with returns", async () => {
    const customer = (await manager.post(`${base}/customers`).send({ name: "History Hari", phone: "0712223334" }).expect(201)).body;

    const linked = await cashier
      .post(`${base}/sales`)
      .send(saleBody(registerId, [{ variantId: item, quantity: 3 }], [{ method: "cash", amount: 300 }], { customerId: customer.id }))
      .expect(201);
    const walkIn = await cashier.post(`${base}/sales`).send(saleBody(registerId, [{ variantId: item, quantity: 1 }], [{ method: "cash", amount: 100 }])).expect(201);
    expect(walkIn.body.customer ?? null).toBeNull();

    await manager
      .post(`${base}/returns`)
      .send({
        id: randomUUID(),
        saleId: linked.body.id,
        registerId,
        reason: "CHANGED_MIND",
        items: [{ saleItemId: linked.body.items[0].id, quantity: 1, resellable: true }],
        refunds: [{ method: "cash", amount: 100 }],
      })
      .expect(201);

    const history = await manager.get(`${base}/customers/${customer.id}/history`).expect(200);
    expect(history.body.summary).toMatchObject({ purchases: 1, totalSpent: "300.00", totalRefunded: "100.00", netSpent: "200.00" });
    expect(history.body.sales).toHaveLength(1);
    expect(history.body.sales[0].id).toBe(linked.body.id);
    expect(history.body.sales[0].returns).toHaveLength(1);

    // Sales can be filtered by customer and the walk-in sale is not included
    const filtered = await manager.get(`${base}/sales?customerId=${customer.id}`).expect(200);
    expect(filtered.body.items.map((s: { id: string }) => s.id)).toEqual([linked.body.id]);

    expect((await cashier.get(`${base}/customers/${customer.id}/history`)).status).toBe(403);
    expect((await cashier.post(`${base}/sales`).send(saleBody(registerId, [{ variantId: item, quantity: 1 }], [{ method: "cash", amount: 100 }], { customerId: randomUUID() }))).status).toBeGreaterThanOrEqual(400);
  });
});

describe("Product variants", () => {
  let admin: Agent;
  let manager: Agent;
  let cashier: Agent;
  let registerId: number;
  let productId: string;
  let variantId: string;

  beforeAll(async () => {
    await closeAllShifts();
    admin = await login("admin", "TestPass123!");
    manager = (await makeUser("var_manager", "MANAGER")).agent;
    cashier = (await makeUser("var_cashier", "CASHIER")).agent;
    registerId = (await makeRegister("Variant Register")).id;
    const res = await admin
      .post(`${base}/products`)
      .send({
        name: "Variant Tee",
        variants: [
          { sku: "VAR-S", name: "Small", sellPrice: 1000, costPrice: 600, barcodes: ["VAR-BC-1"], openingStock: 20 },
          { sku: "VAR-M", name: "Medium", sellPrice: 1100, costPrice: 650, barcodes: ["VAR-BC-2"], openingStock: 20 },
        ],
      })
      .expect(201);
    productId = res.body.id;
    variantId = res.body.variants.find((v: { sku: string }) => v.sku === "VAR-S").id;
  });

  it("edits name, SKU, prices, reorder level, barcodes and status; checkout finds the new barcode", async () => {
    const res = await manager
      .patch(`${base}/products/variants/${variantId}`)
      .send({ name: "Small (new)", sku: "VAR-S2", sellPrice: 1250, costPrice: 700, reorderLevel: 5, barcodes: ["VAR-BC-1", "VAR-BC-1B", "VAR-BC-1B"] })
      .expect(200);
    expect(res.body).toMatchObject({ name: "Small (new)", sku: "VAR-S2", reorderLevel: expect.anything() });
    expect(res.body.barcodes.map((b: { barcode: string }) => b.barcode).sort()).toEqual(["VAR-BC-1", "VAR-BC-1B"]);
    expect((await cashier.get(`${base}/products/lookup/VAR-BC-1B`).expect(200)).body.id).toBe(variantId);
    expect(await prisma.auditLog.count({ where: { action: "variant.update", entityId: variantId } })).toBe(1);
    expect((await cashier.patch(`${base}/products/variants/${variantId}`).send({ sellPrice: 1 })).status).toBe(403);
  });

  it("rejects duplicate SKUs and barcodes", async () => {
    const other = (await admin.get(`${base}/products?search=Variant Tee`).expect(200)).body.items[0].variants.find((v: { sku: string }) => v.sku === "VAR-M").id;
    expect((await manager.patch(`${base}/products/variants/${other}`).send({ sku: "VAR-S2" })).status).toBe(409);
    expect((await manager.patch(`${base}/products/variants/${other}`).send({ barcodes: ["VAR-BC-1B"] })).status).toBe(409);
  });

  it("preserves historical sale snapshots when a variant changes and blocks inactive variants", async () => {
    const sale = await cashier.post(`${base}/sales`).send(saleBody(registerId, [{ variantId, quantity: 2 }], [{ method: "cash", amount: 2500 }])).expect(201);
    expect(sale.body.items[0]).toMatchObject({ sku: "VAR-S2", unitPrice: expect.stringMatching(/^1250/) });

    await manager.patch(`${base}/products/variants/${variantId}`).send({ sku: "VAR-S3", name: "Renamed", sellPrice: 2000 }).expect(200);
    const again = await cashier.get(`${base}/sales/${sale.body.id}`).expect(200);
    expect(again.body.items[0]).toMatchObject({ sku: "VAR-S2", unitPrice: expect.stringMatching(/^1250/) });
    expect(again.body.grandTotal).toMatch(/^2500/);

    // Refund uses the original snapshot price, not the new one
    const q = await manager.post(`${base}/returns/quote`).send({ saleId: sale.body.id, items: [{ saleItemId: sale.body.items[0].id, quantity: 1 }] }).expect(200);
    expect(q.body.refundTotal).toBe("1250.00");

    await manager.patch(`${base}/products/variants/${variantId}`).send({ isActive: false }).expect(200);
    const blocked = await cashier.post(`${base}/sales`).send(saleBody(registerId, [{ variantId, quantity: 1 }], [{ method: "cash", amount: 2000 }]));
    expect(blocked.status).toBeGreaterThanOrEqual(400);
    expect(await onHand(variantId)).toBe(18);
    await manager.patch(`${base}/products/variants/${variantId}`).send({ isActive: true }).expect(200);
  });

  it("adds a new variant to an existing product", async () => {
    const res = await manager.post(`${base}/products/${productId}/variants`).send({ sku: "VAR-L", name: "Large", sellPrice: 1300, barcodes: ["VAR-BC-3"], openingStock: 7 }).expect(201);
    expect(await onHand(res.body.id)).toBe(7);
  });
});

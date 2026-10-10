import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { type Agent, base, closeAllShifts, login, makeProduct, makeRegister, makeUser, saleBody, setSettings } from "./helpers.js";

// Every report is queried over an isolated historical window so other test files cannot interfere.
const WINDOW = "from=2025-03-10&to=2025-03-12";

describe("Reports", () => {
  let admin: Agent;
  let manager: Agent;
  let cashier: Agent;
  let registerId: number;
  let item: string;
  let saleA: string;
  let returnId: string;

  beforeAll(async () => {
    await closeAllShifts();
    await setSettings({ taxEnabled: false, pricesIncludeTax: true, requireShift: false, timezone: "Asia/Colombo", allowNegativeStock: false });
    admin = await login("admin", "TestPass123!");
    manager = (await makeUser("rep_manager", "MANAGER")).agent;
    cashier = (await makeUser("rep_cashier", "CASHIER")).agent;
    registerId = (await makeRegister("Reports Register")).id;
    item = await makeProduct(admin, "Report Item", "REP-1", 100, 500, { lowStockThreshold: undefined });

    // Sale A: 2 x 100 less a Rs 20 cart discount = 180 cash; at 19:00 UTC on 10 Mar = 00:30 on 11 Mar in Colombo.
    const a = await cashier
      .post(`${base}/sales`)
      .send(saleBody(registerId, [{ variantId: item, quantity: 2 }], [{ method: "cash", amount: 180 }], { discount: { type: "AMOUNT", value: 20 } }))
      .expect(201);
    saleA = a.body.id;
    // Sale B: 1 x 100 by card on 10 Mar (local).
    const b = await cashier
      .post(`${base}/sales`)
      .send(saleBody(registerId, [{ variantId: item, quantity: 1 }], [{ method: "card", amount: 100, reference: "R-1" }]))
      .expect(201);
    // Return one unit of sale A (Rs 90) in cash on 11 Mar.
    const r = await manager
      .post(`${base}/returns`)
      .send({
        id: randomUUID(),
        saleId: saleA,
        registerId,
        reason: "DAMAGED",
        items: [{ saleItemId: a.body.items[0].id, quantity: 1, resellable: false }],
        refunds: [{ method: "cash", amount: 90 }],
      })
      .expect(201);
    returnId = r.body.id;

    await prisma.sale.update({ where: { id: saleA }, data: { createdAt: new Date("2025-03-10T19:00:00Z") } });
    await prisma.sale.update({ where: { id: b.body.id }, data: { createdAt: new Date("2025-03-10T10:00:00Z") } });
    await prisma.saleReturn.update({ where: { id: returnId }, data: { createdAt: new Date("2025-03-11T05:00:00Z") } });
  });

  it("reports daily sales in the store timezone with refunds netted separately", async () => {
    const res = await manager.get(`${base}/reports/sales?${WINDOW}&groupBy=day`).expect(200);
    const days = Object.fromEntries(res.body.items.map((r: { period: string }) => [String(r.period).slice(0, 10), r]));
    expect(Object.keys(days).sort()).toEqual(["2025-03-10", "2025-03-11"]);
    expect(days["2025-03-10"]).toMatchObject({ salesCount: 1, grossSales: "100.00", salesTotal: "100.00", refunds: "0.00", netSales: "100.00" });
    // Sale A falls on 11 Mar locally even though it is 10 Mar in UTC.
    expect(days["2025-03-11"]).toMatchObject({ salesCount: 1, grossSales: "200.00", discounts: "20.00", salesTotal: "180.00", refunds: "90.00", netSales: "90.00", returnsCount: 1 });
    expect(res.body.totals).toMatchObject({ salesCount: 2, grossSales: "300.00", discounts: "20.00", salesTotal: "280.00", refunds: "90.00", netSales: "190.00" });
  });

  it("groups by week and month", async () => {
    const week = await manager.get(`${base}/reports/sales?${WINDOW}&groupBy=week`).expect(200);
    expect(week.body.items).toHaveLength(1);
    expect(week.body.items[0].netSales).toBe("190.00");
    const month = await manager.get(`${base}/reports/sales?from=2025-03-01&to=2025-03-31&groupBy=month`).expect(200);
    expect(month.body.items).toHaveLength(1);
    expect(month.body.totals.netSales).toBe("190.00");
  });

  it("separates sales revenue from cash collected by payment method", async () => {
    const res = await manager.get(`${base}/reports/payments?${WINDOW}`).expect(200);
    expect(res.body.revenue).toMatchObject({ salesTotal: "280.00", refunds: "90.00", netSales: "190.00" });
    const cash = res.body.methods.find((m: { method: string }) => m.method === "cash");
    const card = res.body.methods.find((m: { method: string }) => m.method === "card");
    expect(cash).toMatchObject({ tendered: "180.00", collected: "180.00", refundsCompleted: "90.00", netCollected: "90.00" });
    expect(card).toMatchObject({ collected: "100.00", refundsCompleted: "0.00", netCollected: "100.00" });
  });

  it("reports products, cashiers and tax with returns netted", async () => {
    const products = await manager.get(`${base}/reports/products?${WINDOW}&search=Report Item`).expect(200);
    expect(products.body.items).toHaveLength(1);
    expect(products.body.items[0]).toMatchObject({ sku: "REP-1" });
    expect(Number(products.body.items[0].quantitySold)).toBe(3);
    expect(Number(products.body.items[0].quantityReturned)).toBe(1);

    const cashiers = await manager.get(`${base}/reports/cashiers?${WINDOW}`).expect(200);
    const row = cashiers.body.items.find((c: { username: string }) => c.username === "rep_cashier");
    expect(row).toMatchObject({ salesCount: 2, salesTotal: "280.00" });

    const tax = await manager.get(`${base}/reports/tax?${WINDOW}`).expect(200);
    expect(tax.body.totals).toMatchObject({ taxCollected: "0.00", taxRefunded: "0.00", netTax: "0.00" }); // VAT disabled by default
  });

  it("reports low stock with pagination", async () => {
    const low = await prisma.productVariant.findFirstOrThrow({ where: { id: item } });
    await prisma.productVariant.update({ where: { id: low.id }, data: { reorderLevel: 100000 } });
    const res = await manager.get(`${base}/reports/low-stock?page=1&pageSize=1`).expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    expect(res.body.pageSize).toBe(1);
    const all = await manager.get(`${base}/reports/low-stock?pageSize=100`).expect(200);
    expect(all.body.items.some((i: { sku: string }) => i.sku === "REP-1")).toBe(true);
    await prisma.productVariant.update({ where: { id: low.id }, data: { reorderLevel: 0 } });
  });

  it("reconciles shifts, including shortages awaiting approval", async () => {
    const reg = await makeRegister("Reports Shift Reg");
    const c = await makeUser("rep_shift_cashier", "CASHIER");
    const shift = (await c.agent.post(`${base}/shifts/open`).send({ registerId: reg.id, openingCash: 500 }).expect(201)).body;
    await c.agent.post(`${base}/shifts/${shift.id}/close`).send({ countedCash: 490, notes: "Short" }).expect(200);
    const res = await manager.get(`${base}/reports/shifts?pageSize=100`).expect(200);
    const row = res.body.items.find((s: { id: number }) => s.id === shift.id);
    expect(row).toMatchObject({ expectedCash: "500.00", countedCash: "490.00", variance: "-10.00" });
    expect(res.body.totals.awaitingApproval).toBeGreaterThanOrEqual(1);
  });

  it("limits reports to managers and admins and validates filters", async () => {
    for (const path of ["sales", "payments", "cashiers", "products", "low-stock", "tax", "shifts"]) {
      expect((await cashier.get(`${base}/reports/${path}`)).status, path).toBe(403);
      expect((await manager.get(`${base}/reports/${path}`)).status, path).toBe(200);
      expect((await admin.get(`${base}/reports/${path}`)).status, path).toBe(200);
    }
    expect((await manager.get(`${base}/reports/sales?from=2025-04-10&to=2025-03-10`)).status).toBe(400);
    expect((await manager.get(`${base}/reports/sales?from=nope`)).status).toBe(400);
  });
});

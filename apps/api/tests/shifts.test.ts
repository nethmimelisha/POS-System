import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { type Agent, base, closeAllShifts, login, makeProduct, makeRegister, makeUser, saleBody, setSettings } from "./helpers.js";

describe("Shifts & cash drawer", () => {
  let admin: Agent;
  let manager: Agent;
  let cashier: Agent;
  let cashier2: Agent;
  let cashier2Id: string;
  let cashierId: string;
  let item: string; // Rs 100

  const open = (agent: Agent, registerId: number, openingCash = 1000, extra: object = {}) =>
    agent.post(`${base}/shifts/open`).send({ registerId, openingCash, ...extra });
  const sell = (agent: Agent, registerId: number, payments: object[], qty = 1) =>
    agent.post(`${base}/sales`).send(saleBody(registerId, [{ variantId: item, quantity: qty }], payments));

  beforeAll(async () => {
    await closeAllShifts();
    await setSettings({ taxEnabled: false, requireShift: false, allowNegativeStock: false });
    admin = await login("admin", "TestPass123!");
    manager = (await makeUser("shift_manager", "MANAGER")).agent;
    const c1 = await makeUser("shift_cashier", "CASHIER");
    const c2 = await makeUser("shift_cashier2", "CASHIER");
    cashier = c1.agent;
    cashier2 = c2.agent;
    cashierId = c1.user.id;
    cashier2Id = c2.user.id;
    item = await makeProduct(admin, "Shift Item", "SHIFT-1", 100, 1000);
  });

  beforeEach(closeAllShifts);

  afterAll(async () => {
    await closeAllShifts();
    await setSettings({ requireShift: false });
  });

  it("opens a shift with an opening balance and links sales to it", async () => {
    const reg = await makeRegister("Shift Reg A");
    expect((await sell(cashier, reg.id, [{ method: "cash", amount: 100 }])).status).toBe(201); // shifts are optional by default
    const res = await open(cashier, reg.id, 5000).expect(201);
    expect(res.body).toMatchObject({ status: "OPEN", cashierId, summary: { openingCash: "5000.00", expectedCash: "5000.00" } });
    const s = await sell(cashier, reg.id, [{ method: "cash", amount: 100 }]).expect(201);
    expect((await prisma.sale.findUniqueOrThrow({ where: { id: s.body.id } })).shiftId).toBe(res.body.id);
    const mine = await cashier.get(`${base}/shifts/mine`).expect(200);
    expect(mine.body.summary).toMatchObject({ cashSales: "100.00", expectedCash: "5100.00", salesCount: 1 });
    expect((await cashier.get(`${base}/shifts/current?registerId=${reg.id}`)).body.id).toBe(res.body.id);
    expect(await prisma.auditLog.count({ where: { action: "shift.open", entityId: String(res.body.id) } })).toBe(1);
    await closeAllShifts();
  });

  it("prevents overlapping shifts on a register or for a cashier", async () => {
    const r1 = await makeRegister("Shift Reg B");
    const r2 = await makeRegister("Shift Reg C");
    await open(cashier, r1.id).expect(201);
    expect((await open(cashier2, r1.id)).status).toBe(409);
    expect((await open(cashier, r2.id)).status).toBe(409);
    expect((await open(cashier2, r2.id, 0, { cashierId })).status).toBe(403); // cashiers cannot assign others
    const assigned = await open(manager, r2.id, 200, { cashierId: cashier2Id }).expect(201);
    expect(assigned.body.cashierId).toBe(cashier2Id);
    await closeAllShifts();
  });

  it("allows only one of many simultaneous shift-opening attempts", async () => {
    const reg = await makeRegister("Shift Reg Race");
    const users = await Promise.all(Array.from({ length: 6 }, (_, i) => makeUser(`shift_racer_${i}`, "CASHIER")));
    const results = await Promise.all(users.map((u) => open(u.agent, reg.id)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    expect(await prisma.shift.count({ where: { registerId: reg.id, status: "OPEN" } })).toBe(1);
    await closeAllShifts();

    const x = await makeRegister("Shift Reg Race X");
    const y = await makeRegister("Shift Reg Race Y");
    const dual = await Promise.all([open(cashier, x.id), open(cashier, y.id)]);
    expect(dual.map((r) => r.status).sort()).toEqual([201, 409]);
    await closeAllShifts();
  });

  it("reconciles cash from cash sales, change, cash in/out and cash refunds, excluding card and online", async () => {
    const reg = await makeRegister("Shift Reg Recon");
    const shift = (await open(cashier, reg.id, 1000).expect(201)).body;

    const cashSale = await sell(cashier, reg.id, [{ method: "cash", amount: 500 }], 3).expect(201); // 300 due, 200 change
    await sell(cashier, reg.id, [{ method: "card", amount: 200, reference: "C-1" }], 2).expect(201);
    await sell(cashier, reg.id, [{ method: "online", amount: 100, reference: "O-1" }], 1).expect(201);

    const mv = (body: object) => cashier.post(`${base}/shifts/${shift.id}/cash-movements`).send(body);
    await mv({ type: "CASH_IN", amount: 150, reason: "Float top-up" }).expect(201);
    await mv({ type: "CASH_OUT", amount: 50, reason: "Petty cash" }).expect(201);
    expect((await mv({ type: "CASH_OUT", amount: 50 })).status).toBe(400); // reason required
    expect((await mv({ type: "CASH_OUT", amount: 99999, reason: "Too much" })).status).toBe(409);

    // A cash refund of one unit (Rs 100) from the cash sale
    const itemId = cashSale.body.items[0].id;
    await manager
      .post(`${base}/returns`)
      .send({
        id: randomUUID(),
        saleId: cashSale.body.id,
        registerId: reg.id,
        reason: "CHANGED_MIND",
        items: [{ saleItemId: itemId, quantity: 1, resellable: true }],
        refunds: [{ method: "cash", amount: 100 }],
      })
      .expect(201);

    // 1000 + 500 tendered - 200 change + 150 - 50 - 100 = 1300
    const view = (await cashier.get(`${base}/shifts/${shift.id}`).expect(200)).body;
    expect(view.summary).toMatchObject({
      openingCash: "1000.00",
      cashSales: "500.00",
      changeGiven: "200.00",
      cashIn: "150.00",
      cashOut: "50.00",
      cashRefunds: "100.00",
      expectedCash: "1300.00",
    });
    expect(view.summary.nonCashSales.map((n: { method: string }) => n.method).sort()).toHaveLength(2);

    // Shortage needs notes
    expect((await cashier.post(`${base}/shifts/${shift.id}/close`).send({ countedCash: 1290 })).status).toBe(400);
    const closed = await cashier.post(`${base}/shifts/${shift.id}/close`).send({ countedCash: 1290, notes: "Counted twice" }).expect(200);
    expect(closed.body).toMatchObject({ status: "CLOSED", expectedCash: "1300.00", countedCash: "1290.00", variance: "-10.00", discrepancy: "PENDING_APPROVAL" });
    expect((await cashier.post(`${base}/shifts/${shift.id}/close`).send({ countedCash: 1300 })).status).toBe(409); // already closed

    // The register and cashier are free again
    await open(cashier, reg.id, 0).expect(201);
    await closeAllShifts();

    // Approval: cashiers cannot, a manager can, and only once
    expect((await cashier.post(`${base}/shifts/${shift.id}/approve`).send({ note: "ok ok" })).status).toBe(403);
    const ok = await manager.post(`${base}/shifts/${shift.id}/approve`).send({ note: "Verified on camera" }).expect(200);
    expect(ok.body).toMatchObject({ discrepancy: "APPROVED" });
    expect((await manager.post(`${base}/shifts/${shift.id}/approve`).send({ note: "again" })).status).toBe(409);
  });

  it("closes a balanced shift without a discrepancy", async () => {
    const reg = await makeRegister("Shift Reg Balanced");
    const shift = (await open(cashier2, reg.id, 100).expect(201)).body;
    await sell(cashier2, reg.id, [{ method: "cash", amount: 100 }]).expect(201);
    const closed = await cashier2.post(`${base}/shifts/${shift.id}/close`).send({ countedCash: 200 }).expect(200);
    expect(closed.body).toMatchObject({ variance: "0.00", discrepancy: "NONE" });
  });

  it("restricts who may close shifts or see them", async () => {
    const reg = await makeRegister("Shift Reg Perms");
    const shift = (await open(cashier, reg.id, 0).expect(201)).body;
    expect((await cashier2.post(`${base}/shifts/${shift.id}/close`).send({ countedCash: 0 })).status).toBe(404); // other cashiers cannot even see it
    expect((await cashier2.post(`${base}/shifts/${shift.id}/cash-movements`).send({ type: "CASH_IN", amount: 5, reason: "nope" })).status).toBe(404);
    const list = await cashier2.get(`${base}/shifts`).expect(200);
    expect(list.body.items.every((s: { cashierId: string }) => s.cashierId === cashier2Id)).toBe(true);
    expect((await manager.get(`${base}/shifts?status=OPEN`).expect(200)).body.items.some((s: { id: number }) => s.id === shift.id)).toBe(true);
    await manager.post(`${base}/shifts/${shift.id}/close`).send({ countedCash: 0 }).expect(200); // manager may close
  });

  it("enforces shifts on sales when requireShift is on", async () => {
    const reg = await makeRegister("Shift Reg Required");
    await setSettings({ requireShift: true });
    try {
      const denied = await sell(cashier, reg.id, [{ method: "cash", amount: 100 }]);
      expect(denied.status).toBe(409);
      expect(denied.body.error).toMatch(/Open a shift/);
      await open(cashier2, reg.id, 0).expect(201);
      const other = await sell(cashier, reg.id, [{ method: "cash", amount: 100 }]);
      expect([403, 409]).toContain(other.status);
      expect((await sell(cashier2, reg.id, [{ method: "cash", amount: 100 }])).status).toBe(201);
    } finally {
      await setSettings({ requireShift: false });
      await closeAllShifts();
    }
  });
});

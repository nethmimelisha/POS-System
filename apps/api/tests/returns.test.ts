import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { type Agent, base, closeAllShifts, makeProduct, makeRegister, makeUser, onHand, saleBody, setSettings } from "./helpers.js";
import { login } from "./helpers.js";

describe("Returns & refunds", () => {
  let admin: Agent;
  let manager: Agent;
  let cashier: Agent;
  let registerId: number;
  let a: string; // Rs 100, stock 100
  let b: string; // Rs 250, stock 100
  let odd: string; // Rs 10, stock 100 (cart discount makes uneven shares)

  const checkout = async (items: { variantId: string; quantity: number }[], payments: object[], extra: object = {}) => {
    const body = saleBody(registerId, items, payments, extra);
    const res = await cashier.post(`${base}/sales`).send(body).expect(201);
    return res.body as { id: string; items: { id: string; variantId: string; quantity: string }[]; grandTotal: string };
  };
  const ret = (saleId: string, items: object[], refunds: object[], extra: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    saleId,
    registerId,
    reason: "DEFECTIVE",
    items,
    refunds,
    ...extra,
  });
  const itemOf = (sale: { items: { id: string; variantId: string }[] }, variantId: string) => sale.items.find((i) => i.variantId === variantId)!.id;

  beforeAll(async () => {
    await closeAllShifts();
    await setSettings({ taxEnabled: false, pricesIncludeTax: true, allowNegativeStock: false, requireShift: false });
    ({ agent: admin } = { agent: await login("admin", "TestPass123!") });
    ({ agent: manager } = await makeUser("ret_manager", "MANAGER"));
    ({ agent: cashier } = await makeUser("ret_cashier", "CASHIER"));
    registerId = (await makeRegister("Returns Register")).id;
    a = await makeProduct(admin, "Ret A", "RET-A", 100);
    b = await makeProduct(admin, "Ret B", "RET-B", 250);
    odd = await makeProduct(admin, "Ret Odd", "RET-ODD", 10);
  });

  it("refunds a full return in cash, restocks resellable items and records the audit trail", async () => {
    const before = await onHand(a);
    const sale = await checkout([{ variantId: a, quantity: 4 }], [{ method: "cash", amount: 400 }]);
    expect(await onHand(a)).toBe(before - 4);

    const res = await manager
      .post(`${base}/returns`)
      .send(ret(sale.id, [{ saleItemId: itemOf(sale, a), quantity: 4, resellable: true }], [{ method: "cash", amount: 400 }]))
      .expect(201);
    expect(res.body).toMatchObject({ refundTotal: "400.00", reason: "DEFECTIVE" });
    expect(res.body.returnNumber).toMatch(/^RET-\d{6}$/);
    expect(res.body.refunds[0]).toMatchObject({ status: "COMPLETED", amount: "400.00" });
    expect(res.body.items[0]).toMatchObject({ resellable: true, restocked: true });
    expect(await onHand(a)).toBe(before);

    const move = await prisma.stockMovement.findFirst({ where: { referenceType: "return", referenceId: res.body.id } });
    expect(move).toMatchObject({ type: "RETURN_IN", variantId: a });
    expect(Number(move!.quantity)).toBe(4);
    const log = await prisma.auditLog.findFirst({ where: { action: "return.create", entityId: res.body.id } });
    expect(log).not.toBeNull();

    // The original invoice lists the return and its items are all consumed.
    const detail = await cashier.get(`${base}/sales/${sale.id}`).expect(200);
    expect(detail.body.returns).toHaveLength(1);
    const left = await manager.get(`${base}/returns/sale/${sale.id}/returnable`).expect(200);
    expect(left.body.fullyReturned).toBe(true);
  });

  it("supports partial returns and exact refund arithmetic across several returns", async () => {
    // 3 x Rs 10 = 30.00, less a Rs 1.00 cart discount = 29.00 paid
    const withDiscount = await cashier
      .post(`${base}/sales`)
      .send(saleBody(registerId, [{ variantId: odd, quantity: 3 }], [{ method: "cash", amount: 29 }], { discount: { type: "AMOUNT", value: 1 } }))
      .expect(201);
    expect(Number(withDiscount.body.grandTotal)).toBe(29);
    const id = itemOf(withDiscount.body, odd);

    const refunds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const q = await manager.post(`${base}/returns/quote`).send({ saleId: withDiscount.body.id, items: [{ saleItemId: id, quantity: 1 }] }).expect(200);
      const r = await manager
        .post(`${base}/returns`)
        .send(ret(withDiscount.body.id, [{ saleItemId: id, quantity: 1, resellable: true }], [{ method: "cash", amount: Number(q.body.refundTotal) }]))
        .expect(201);
      refunds.push(r.body.refundTotal);
    }
    // 9.67 + 9.67 + 9.66: the last unit takes the remainder, so the total is exactly what was paid.
    expect(refunds).toEqual(["9.67", "9.67", "9.66"]);
    const r4 = await manager.post(`${base}/returns`).send(ret(withDiscount.body.id, [{ saleItemId: id, quantity: 1, resellable: true }], [{ method: "cash", amount: 1 }]));
    expect(r4.status).toBe(409);
    expect(r4.body.error).toMatch(/already been fully returned/);
  });

  it("validates quantities against what was sold and previously returned", async () => {
    const sale = await checkout([{ variantId: b, quantity: 3 }], [{ method: "cash", amount: 750 }]);
    const id = itemOf(sale, b);
    const send = (q: number, amount: number) =>
      manager.post(`${base}/returns`).send(ret(sale.id, [{ saleItemId: id, quantity: q, resellable: true }], [{ method: "cash", amount }]));

    expect((await send(4, 1000)).status).toBe(409);
    expect((await send(0, 0)).status).toBe(400);
    await send(2, 500).then((r) => expect(r.status).toBe(201));
    const over = await send(2, 500);
    expect(over.status).toBe(409);
    expect(over.body.error).toMatch(/only 1 remaining/);
    expect((await send(1, 250)).status).toBe(201);
    // An item from another sale is rejected
    const other = await checkout([{ variantId: b, quantity: 1 }], [{ method: "cash", amount: 250 }]);
    const foreign = await manager.post(`${base}/returns`).send(ret(sale.id, [{ saleItemId: itemOf(other, b), quantity: 1, resellable: true }], [{ method: "cash", amount: 250 }]));
    expect(foreign.status).toBe(400);
  });

  it("restocks only items marked resellable", async () => {
    const sale = await checkout([{ variantId: a, quantity: 2 }, { variantId: b, quantity: 2 }], [{ method: "cash", amount: 700 }]);
    const [ba, bb] = [await onHand(a), await onHand(b)];
    const res = await manager
      .post(`${base}/returns`)
      .send(
        ret(
          sale.id,
          [
            { saleItemId: itemOf(sale, a), quantity: 2, resellable: true },
            { saleItemId: itemOf(sale, b), quantity: 2, resellable: false },
          ],
          [{ method: "cash", amount: 700 }],
          { reason: "DAMAGED" },
        ),
      )
      .expect(201);
    expect(await onHand(a)).toBe(ba + 2);
    expect(await onHand(b)).toBe(bb); // damaged goods are not put back on the shelf
    const byVariant = Object.fromEntries(res.body.items.map((i: { sku: string; restocked: boolean }) => [i.sku, i.restocked]));
    expect(byVariant).toEqual({ "RET-A": true, "RET-B": false });
  });

  it("is idempotent: retrying the same return id replays it instead of refunding again", async () => {
    const sale = await checkout([{ variantId: a, quantity: 2 }], [{ method: "cash", amount: 200 }]);
    const body = ret(sale.id, [{ saleItemId: itemOf(sale, a), quantity: 1, resellable: true }], [{ method: "cash", amount: 100 }]);
    const before = await onHand(a);
    const first = await manager.post(`${base}/returns`).send(body).expect(201);
    const second = await manager.post(`${base}/returns`).send(body).expect(200);
    expect(second.headers["idempotent-replay"]).toBe("true");
    expect(second.body.returnNumber).toBe(first.body.returnNumber);
    expect(await onHand(a)).toBe(before + 1);
    expect(await prisma.saleReturn.count({ where: { saleId: sale.id } })).toBe(1);
    // Reusing the id with a different payload is refused
    const changed = { ...body, items: [{ saleItemId: itemOf(sale, a), quantity: 2, resellable: true }], refunds: [{ method: "cash", amount: 200 }] };
    expect((await manager.post(`${base}/returns`).send(changed)).status).toBe(409);
  });

  it("cannot refund the same item twice when return requests arrive concurrently", async () => {
    const sale = await checkout([{ variantId: a, quantity: 5 }], [{ method: "cash", amount: 500 }]);
    const before = await onHand(a);
    const id = itemOf(sale, a);
    const attempts = await Promise.all(
      Array.from({ length: 6 }, () =>
        manager.post(`${base}/returns`).send(ret(sale.id, [{ saleItemId: id, quantity: 5, resellable: true }], [{ method: "cash", amount: 500 }])),
      ),
    );
    expect(attempts.filter((r) => r.status === 201)).toHaveLength(1);
    expect(attempts.filter((r) => r.status === 409)).toHaveLength(5);
    const refunded = await prisma.saleReturn.aggregate({ where: { saleId: sale.id }, _sum: { refundTotal: true } });
    expect(Number(refunded._sum.refundTotal)).toBe(500);
    expect(await onHand(a)).toBe(before + 5);

    // Concurrent partial returns can never exceed the sold quantity either.
    const sale2 = await checkout([{ variantId: a, quantity: 4 }], [{ method: "cash", amount: 400 }]);
    const id2 = itemOf(sale2, a);
    const partials = await Promise.all(
      Array.from({ length: 4 }, () => manager.post(`${base}/returns`).send(ret(sale2.id, [{ saleItemId: id2, quantity: 2, resellable: true }], [{ method: "cash", amount: 200 }]))),
    );
    expect(partials.filter((r) => r.status === 201)).toHaveLength(2);
    const sum = await prisma.returnItem.aggregate({ where: { saleItemId: BigInt(id2) }, _sum: { quantity: true } });
    expect(Number(sum._sum.quantity)).toBe(4);
  });

  it("restricts refunds to managers and admins", async () => {
    const sale = await checkout([{ variantId: a, quantity: 1 }], [{ method: "cash", amount: 100 }]);
    const body = ret(sale.id, [{ saleItemId: itemOf(sale, a), quantity: 1, resellable: true }], [{ method: "cash", amount: 100 }]);
    expect((await cashier.post(`${base}/returns`).send(body)).status).toBe(403);
    expect((await cashier.get(`${base}/returns`)).status).toBe(403);
    expect((await cashier.post(`${base}/returns/quote`).send({ saleId: sale.id, items: [{ saleItemId: itemOf(sale, a), quantity: 1 }] })).status).toBe(403);
    expect(await prisma.saleReturn.count({ where: { saleId: sale.id } })).toBe(0);
    expect((await admin.post(`${base}/returns`).send(body)).status).toBe(201);
  });

  it("rejects refund amounts that do not add up to the returned value", async () => {
    const sale = await checkout([{ variantId: a, quantity: 2 }], [{ method: "cash", amount: 200 }]);
    const id = itemOf(sale, a);
    const bad = await manager.post(`${base}/returns`).send(ret(sale.id, [{ saleItemId: id, quantity: 1, resellable: true }], [{ method: "cash", amount: 150 }]));
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/add up to Rs\. 100\.00/);
    const none = await manager.post(`${base}/returns`).send(ret(sale.id, [{ saleItemId: id, quantity: 1, resellable: true }], []));
    expect(none.status).toBe(400);
    expect(await prisma.saleReturn.count({ where: { saleId: sale.id } })).toBe(0);
  });

  it("keeps card and online refunds PENDING until the provider confirms them", async () => {
    const sale = await checkout([{ variantId: b, quantity: 2 }], [{ method: "card", amount: 300, reference: "AUTH-1" }, { method: "cash", amount: 200 }]);
    const id = itemOf(sale, b);
    // Cannot refund more to the card than was paid by card
    const tooMuch = await manager.post(`${base}/returns`).send(ret(sale.id, [{ saleItemId: id, quantity: 2, resellable: true }], [{ method: "card", amount: 500 }]));
    expect(tooMuch.status).toBe(409);

    const res = await manager
      .post(`${base}/returns`)
      .send(ret(sale.id, [{ saleItemId: id, quantity: 2, resellable: true }], [{ method: "card", amount: 300, reference: "REQ-9" }, { method: "cash", amount: 200 }]))
      .expect(201);
    const card = res.body.refunds.find((r: { method: { code: string } }) => r.method.code === "card");
    const cash = res.body.refunds.find((r: { method: { code: string } }) => r.method.code === "cash");
    expect(card.status).toBe("PENDING");
    expect(cash.status).toBe("COMPLETED");

    const receipt = await manager.get(`${base}/returns/${res.body.id}/receipt`).expect(200);
    expect(receipt.body.refunds.find((r: { method: string }) => r.method === "Card").statusNote).toMatch(/Awaiting payment provider/);

    expect((await manager.post(`${base}/returns/${res.body.id}/refunds/${card.id}/confirm`).send({})).status).toBe(400);
    expect((await cashier.post(`${base}/returns/${res.body.id}/refunds/${card.id}/confirm`).send({ providerReference: "X" })).status).toBe(403);
    const confirmed = await manager.post(`${base}/returns/${res.body.id}/refunds/${card.id}/confirm`).send({ providerReference: "BANK-REF-1" }).expect(200);
    expect(confirmed.body.refunds.find((r: { id: number }) => r.id === card.id)).toMatchObject({ status: "COMPLETED", providerReference: "BANK-REF-1" });
    // A confirmed refund cannot be confirmed (or failed) again, and cash refunds cannot be resolved this way
    expect((await manager.post(`${base}/returns/${res.body.id}/refunds/${card.id}/confirm`).send({ providerReference: "BANK-REF-1" })).status).toBe(409);
    expect((await manager.post(`${base}/returns/${res.body.id}/refunds/${cash.id}/confirm`).send({ providerReference: "X" })).status).toBe(409);
    expect(await prisma.auditLog.count({ where: { action: "refund.confirm", entityId: res.body.id } })).toBe(1);
  });

  it("lets a failed external refund be re-issued for the unpaid amount only", async () => {
    const sale = await checkout([{ variantId: a, quantity: 1 }], [{ method: "online", amount: 100, reference: "WAL-1" }]);
    const r = await manager
      .post(`${base}/returns`)
      .send(ret(sale.id, [{ saleItemId: itemOf(sale, a), quantity: 1, resellable: true }], [{ method: "online", amount: 100 }]))
      .expect(201);
    const refundId = r.body.refunds[0].id;
    await manager.post(`${base}/returns/${r.body.id}/refunds/${refundId}/fail`).send({ reason: "Wallet closed" }).expect(200);
    expect((await manager.post(`${base}/returns/${r.body.id}/refunds`).send({ method: "cash", amount: 100 })).status).toBe(400);
    expect((await manager.post(`${base}/returns/${r.body.id}/refunds`).send({ method: "online", amount: 150 })).status).toBe(409);
    const again = await manager.post(`${base}/returns/${r.body.id}/refunds`).send({ method: "card", amount: 100 }).expect(201);
    expect(again.body.refunds.map((x: { status: string }) => x.status)).toEqual(["FAILED", "PENDING"]);
  });

  it("lists return history and finds invoices by number", async () => {
    const list = await manager.get(`${base}/returns?pageSize=5`).expect(200);
    expect(list.body.total).toBeGreaterThan(5);
    expect(list.body.items).toHaveLength(5);
    const pending = await manager.get(`${base}/returns?pendingRefunds=true`).expect(200);
    expect(pending.body.items.every((r: { refunds: { status: string }[] }) => r.refunds.some((x) => x.status === "PENDING"))).toBe(true);
    const sales = await manager.get(`${base}/sales?search=INV-0000`).expect(200);
    expect(sales.body.items.length).toBeGreaterThan(0);
  });

  it("links cash refunds to the register's open shift and requires one when configured", async () => {
    const shiftCashier = await makeUser("ret_shift_cashier", "CASHIER");
    const reg = await makeRegister("Returns Shift Register");
    const sale = await shiftCashier.agent.post(`${base}/sales`).send(saleBody(reg.id, [{ variantId: a, quantity: 1 }], [{ method: "cash", amount: 100 }])).expect(201);

    await setSettings({ requireShift: true });
    try {
      const body = { ...ret(sale.body.id, [{ saleItemId: itemOf(sale.body, a), quantity: 1, resellable: true }], [{ method: "cash", amount: 100 }]), registerId: reg.id };
      const blocked = await manager.post(`${base}/returns`).send(body);
      expect(blocked.status).toBe(409);
      expect(blocked.body.error).toMatch(/Open a shift/);
      await shiftCashier.agent.post(`${base}/shifts/open`).send({ registerId: reg.id, openingCash: 1000 }).expect(201);
      const ok = await manager.post(`${base}/returns`).send(body).expect(201);
      expect(ok.body.shiftId).toBeTruthy();
    } finally {
      await setSettings({ requireShift: false });
      await closeAllShifts();
    }
  });
});

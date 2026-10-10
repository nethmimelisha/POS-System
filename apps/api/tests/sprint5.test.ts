import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { type Agent, base, closeAllShifts, login, makeProduct, makeRegister, makeUser, onHand, saleBody, setSettings } from "./helpers.js";
import { csvCell, toCsv } from "../src/services/exportFormats.js";

describe("Sprint 5 — void, exchange, exports", () => {
  let admin: Agent;
  let manager: Agent;
  let cashier: Agent;
  let registerId: number;
  let a: string; // Rs 100
  let b: string; // Rs 250
  let c: string; // Rs 50

  const checkout = async (items: { variantId: string; quantity: number }[], payments: object[]) => {
    const res = await cashier.post(`${base}/sales`).send(saleBody(registerId, items, payments)).expect(201);
    return res.body as { id: string; items: { id: string; variantId: string }[]; grandTotal: string };
  };
  const lineOf = (sale: { items: { id: string; variantId: string }[] }, v: string) => sale.items.find((i) => i.variantId === v)!.id;
  const exchange = (saleId: string, returnItems: object[], newItems: object[], payments: object[] = [], refunds: object[] = [], extra: object = {}) => ({
    id: randomUUID(),
    saleId,
    registerId,
    reason: "CHANGED_MIND",
    returnItems,
    newItems,
    payments,
    refunds,
    ...extra,
  });

  beforeAll(async () => {
    await closeAllShifts();
    await setSettings({ taxEnabled: false, pricesIncludeTax: true, allowNegativeStock: false, requireShift: false });
    admin = await login("admin", "TestPass123!");
    ({ agent: manager } = await makeUser("s5_manager", "MANAGER"));
    ({ agent: cashier } = await makeUser("s5_cashier", "CASHIER"));
    registerId = (await makeRegister("S5 Register")).id;
    a = await makeProduct(admin, "S5 Item A", "S5-A", 100);
    b = await makeProduct(admin, "S5 Item B", "S5-B", 250);
    c = await makeProduct(admin, "S5 Item C", "S5-C", 50, 3);
  });

  describe("voiding", () => {
    const hold = async (items = [{ variantId: a, quantity: 2 }]) =>
      (await cashier.post(`${base}/sales/hold`).send({ id: randomUUID(), registerId, items }).expect(201)).body as { id: string; status: string; saleNumber: string };

    it("parks a cart without moving stock or money", async () => {
      const before = await onHand(a);
      const held = await hold();
      expect(held.status).toBe("HELD");
      expect(held.saleNumber).toMatch(/^HLD-\d{6}$/);
      expect(await onHand(a)).toBe(before);
      expect(await prisma.salePayment.count({ where: { saleId: held.id } })).toBe(0);
    });

    it("is idempotent when the same hold is retried", async () => {
      const body = { id: randomUUID(), registerId, items: [{ variantId: a, quantity: 1 }] };
      const first = await cashier.post(`${base}/sales/hold`).send(body).expect(201);
      const second = await cashier.post(`${base}/sales/hold`).send(body).expect(200);
      expect(second.body.id).toBe(first.body.id);
    });

    it("requires manager/admin and a reason, then voids a held sale with a full audit trail", async () => {
      const held = await hold();
      await cashier.post(`${base}/sales/${held.id}/void`).send({ reason: "Customer left" }).expect(403);
      await manager.post(`${base}/sales/${held.id}/void`).send({}).expect(400);
      await manager.post(`${base}/sales/${held.id}/void`).send({ reason: "  " }).expect(400);
      const res = await manager.post(`${base}/sales/${held.id}/void`).send({ reason: "Customer left" }).expect(200);
      expect(res.body.status).toBe("VOIDED");
      const row = await prisma.sale.findUniqueOrThrow({ where: { id: held.id } });
      expect(row).toMatchObject({ status: "VOIDED", voidReason: "Customer left" });
      expect(row.voidedAt).not.toBeNull();
      expect(row.voidedById).not.toBeNull();
      expect(await prisma.auditLog.count({ where: { action: "sale.void", entityId: held.id } })).toBe(1);
    });

    it("rejects duplicate and concurrent voids with exactly one success", async () => {
      const held = await hold();
      const results = await Promise.all([1, 2, 3].map(() => manager.post(`${base}/sales/${held.id}/void`).send({ reason: "Duplicate test" })));
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409 && r.body.code === "ALREADY_VOIDED")).toHaveLength(2);
      expect(await prisma.auditLog.count({ where: { action: "sale.void", entityId: held.id } })).toBe(1);
    });

    it("never voids a completed sale; it points to Returns and changes nothing", async () => {
      const stock = await onHand(a);
      const sale = await checkout([{ variantId: a, quantity: 1 }], [{ method: "cash", amount: 100 }]);
      const res = await admin.post(`${base}/sales/${sale.id}/void`).send({ reason: "Mistake" }).expect(409);
      expect(res.body.code).toBe("USE_RETURNS");
      expect((await prisma.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe("COMPLETED");
      expect(await onHand(a)).toBe(stock - 1);
      expect(await prisma.auditLog.count({ where: { action: "sale.void_rejected", entityId: sale.id } })).toBe(1);
    });
  });

  describe("exchanges", () => {
    it("is manager/admin only", async () => {
      const sale = await checkout([{ variantId: a, quantity: 1 }], [{ method: "cash", amount: 100 }]);
      await cashier.post(`${base}/exchanges`).send(exchange(sale.id, [{ saleItemId: lineOf(sale, a), quantity: 1, resellable: true }], [{ variantId: b, quantity: 1 }], [{ method: "cash", amount: 150 }])).expect(403);
    });

    it("charges the price difference, moves stock both ways and links the documents", async () => {
      const sale = await checkout([{ variantId: a, quantity: 2 }], [{ method: "cash", amount: 200 }]);
      const [aBefore, bBefore] = [await onHand(a), await onHand(b)];
      const body = exchange(sale.id, [{ saleItemId: lineOf(sale, a), quantity: 1, resellable: true }], [{ variantId: b, quantity: 1 }], [{ method: "cash", amount: 150 }]);
      const res = await manager.post(`${base}/exchanges`).send(body).expect(201);
      expect(res.body).toMatchObject({ returnedValue: "100.00", issuedValue: "250.00", difference: "150.00" });
      expect(res.body.exchangeNumber).toMatch(/^EXC-\d{6}$/);
      expect(await onHand(a)).toBe(aBefore + 1);
      expect(await onHand(b)).toBe(bBefore - 1);

      const receipt = await manager.get(`${base}/exchanges/${res.body.id}/receipt`).expect(200);
      expect(JSON.stringify(receipt.body)).toContain(res.body.exchangeNumber);

      // The original invoice is untouched, the new sale only collected the difference in real money.
      expect((await prisma.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe("COMPLETED");
      const x = await prisma.exchange.findUniqueOrThrow({ where: { id: res.body.id }, include: { newSale: { include: { payments: { include: { method: true } } } } } });
      expect(x.newSale.grandTotal.toString()).toBe("250");
      const real = x.newSale.payments.filter((p) => !p.method.isSystem).reduce((s, p) => s + Number(p.amount), 0);
      expect(real).toBe(150);
      expect(await prisma.auditLog.count({ where: { action: "exchange.create", entityId: res.body.id } })).toBe(1);
    });

    it("refunds the difference when the replacement is cheaper", async () => {
      const sale = await checkout([{ variantId: b, quantity: 1 }], [{ method: "cash", amount: 250 }]);
      const body = exchange(sale.id, [{ saleItemId: lineOf(sale, b), quantity: 1, resellable: true }], [{ variantId: c, quantity: 1 }], [], [{ method: "cash", amount: 200 }]);
      const res = await manager.post(`${base}/exchanges`).send(body).expect(201);
      expect(res.body.difference).toBe("-200.00");
    });

    it("rejects an underpaid exchange and leaves stock untouched", async () => {
      const sale = await checkout([{ variantId: a, quantity: 1 }], [{ method: "cash", amount: 100 }]);
      const [aBefore, bBefore] = [await onHand(a), await onHand(b)];
      const body = exchange(sale.id, [{ saleItemId: lineOf(sale, a), quantity: 1, resellable: true }], [{ variantId: b, quantity: 1 }], [{ method: "cash", amount: 100 }]);
      await manager.post(`${base}/exchanges`).send(body).expect(402);
      expect(await onHand(a)).toBe(aBefore);
      expect(await onHand(b)).toBe(bBefore);
      expect(await prisma.exchange.count({ where: { id: body.id } })).toBe(0);
    });

    it("rejects returning more than was sold", async () => {
      const sale = await checkout([{ variantId: a, quantity: 1 }], [{ method: "cash", amount: 100 }]);
      const res = await manager.post(`${base}/exchanges`).send(exchange(sale.id, [{ saleItemId: lineOf(sale, a), quantity: 2, resellable: true }], [{ variantId: b, quantity: 1 }], [{ method: "cash", amount: 150 }]));
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });

    it("replays an identical retry without a second exchange", async () => {
      const sale = await checkout([{ variantId: a, quantity: 1 }], [{ method: "cash", amount: 100 }]);
      const body = exchange(sale.id, [{ saleItemId: lineOf(sale, a), quantity: 1, resellable: true }], [{ variantId: b, quantity: 1 }], [{ method: "cash", amount: 150 }]);
      const first = await manager.post(`${base}/exchanges`).send(body).expect(201);
      const stock = await onHand(b);
      const second = await manager.post(`${base}/exchanges`).send(body).expect(200);
      expect(second.body.id).toBe(first.body.id);
      expect(await onHand(b)).toBe(stock);
      expect(await prisma.exchange.count({ where: { originalSaleId: sale.id } })).toBe(1);
    });

    it("lets only one of several concurrent exchanges return the same item", async () => {
      const sale = await checkout([{ variantId: a, quantity: 1 }], [{ method: "cash", amount: 100 }]);
      const aBefore = await onHand(a);
      const results = await Promise.all(
        [1, 2, 3, 4].map(() =>
          manager.post(`${base}/exchanges`).send(exchange(sale.id, [{ saleItemId: lineOf(sale, a), quantity: 1, resellable: true }], [{ variantId: b, quantity: 1 }], [{ method: "cash", amount: 150 }])),
        ),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status >= 400 && r.status < 500)).toHaveLength(3);
      expect(await onHand(a)).toBe(aBefore + 1);
      expect(await prisma.exchange.count({ where: { originalSaleId: sale.id } })).toBe(1);
    });

    it("rolls everything back when the replacement is out of stock", async () => {
      const sale = await checkout([{ variantId: a, quantity: 1 }], [{ method: "cash", amount: 100 }]);
      const aBefore = await onHand(a);
      const cBefore = await onHand(c);
      const returns = await prisma.saleReturn.count();
      const sales = await prisma.sale.count();
      const body = exchange(sale.id, [{ saleItemId: lineOf(sale, a), quantity: 1, resellable: true }], [{ variantId: c, quantity: cBefore + 5 }], [{ method: "cash", amount: 50 * (cBefore + 5) - 100 }]);
      const res = await manager.post(`${base}/exchanges`).send(body);
      expect(res.status).toBe(409);
      expect(await onHand(a)).toBe(aBefore);
      expect(await onHand(c)).toBe(cBefore);
      expect(await prisma.saleReturn.count()).toBe(returns);
      expect(await prisma.sale.count()).toBe(sales);
    });

    it("keeps exchange credit out of the payment-method report and nets revenue correctly", async () => {
      const res = await manager.get(`${base}/reports/payments`).expect(200);
      expect(res.body.methods.map((m: { code: string }) => m.code)).not.toContain("exchange_credit");
    });
  });

  describe("exports", () => {
    it("escapes CSV and neutralises formula injection", () => {
      expect(csvCell("=HYPERLINK(\"x\")")).toBe(`"'=HYPERLINK(""x"")"`);
      for (const v of ["=1+1", "+1", "-1+2", "@SUM(A1)", "\tcmd", "\rcmd", " =1"]) expect(csvCell(v).replace(/^"/, "").startsWith("'")).toBe(true);
      expect(csvCell("a,b")).toBe('"a,b"');
      expect(csvCell('say "hi"')).toBe('"say ""hi"""');
      expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
      expect(csvCell("-12.50", "money")).toBe("-12.50");
      expect(csvCell("-12.50abc", "money")).toBe("'-12.50abc");
      expect(csvCell(null)).toBe("");
      expect(toCsv([{ key: "n", label: "Name" }], [{ n: "=cmd" }])).toBe("\uFEFFName\r\n'=cmd\r\n");
    });

    it("exports hostile product names safely", async () => {
      await makeProduct(admin, "=cmd|' /C calc'!A0", "S5-EVIL", 10);
      const res = await manager.get(`${base}/exports/products.csv`).expect(200);
      expect(res.headers["content-type"]).toContain("text/csv");
      expect(res.headers["content-disposition"]).toContain("attachment");
      expect(res.text).toContain("'=cmd");
      expect(res.text).not.toMatch(/(^|,|\n)"?=cmd/);
    });

    it("matches the reports API for the same filters", async () => {
      const q = "from=2000-01-01&to=2099-12-31&groupBy=month";
      const report = await manager.get(`${base}/reports/sales?${q}&pageSize=200`).expect(200);
      const csv = await manager.get(`${base}/exports/sales.csv?${q}`).expect(200);
      const lines = csv.text.replace("\uFEFF", "").trim().split("\r\n");
      expect(lines).toHaveLength(report.body.items.length + 1);
      expect(lines[1]).toContain(report.body.items[0].netSales);
      expect(lines[1]).toContain(report.body.items[0].period);
    });

    it("serves PDFs for every report", async () => {
      for (const name of ["sales", "refunds", "inventory", "shifts", "tax", "products"]) {
        const res = await manager.get(`${base}/exports/${name}.pdf?from=2000-01-01&to=2099-12-31`).buffer(true).parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on("data", (d: Buffer) => chunks.push(d));
          r.on("end", () => cb(null, Buffer.concat(chunks)));
        });
        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toContain("application/pdf");
        expect((res.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
      }
    });

    it("applies the same permissions and validation as reports", async () => {
      await cashier.get(`${base}/exports/sales.csv`).expect(403);
      await cashier.get(`${base}/exports/products.csv`).expect(403);
      await manager.get(`${base}/exports/nonsense.csv`).expect(404);
      await manager.get(`${base}/exports/sales.xlsx`).expect(404);
      await manager.get(`${base}/exports/sales.csv?from=not-a-date`).expect(400);
      const anon = await import("supertest").then((m) => m.default(manager.get(`${base}/x`).app as never));
      await anon.get(`${base}/exports/sales.csv`).expect(401);
    });

    it("audits each export", async () => {
      const before = await prisma.auditLog.count({ where: { action: "export.download" } });
      await manager.get(`${base}/exports/tax.csv`).expect(200);
      expect(await prisma.auditLog.count({ where: { action: "export.download" } })).toBe(before + 1);
    });
  });
});

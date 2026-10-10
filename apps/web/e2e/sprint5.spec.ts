import { expect, test, type Page } from "@playwright/test";
import { login, onHand, shot } from "./helpers";

const CODE_A = "9990000000501";
const CODE_B = "9990000000502";
const nav = (page: Page, name: string) => page.getByRole("navigation", { name: "Main", exact: true }).getByRole("link", { name }).click();

test.describe.configure({ mode: "serial" });

let invoice = "";
let heldNumber = "";
let regId = 1;

async function cardSale(page: Page, code: string) {
  const item = await (await page.request.get(`/api/v1/products/lookup/${code}`)).json();
  const res = await page.request.post("/api/v1/sales", {
    data: { id: crypto.randomUUID(), registerId: regId, items: [{ variantId: item.id, quantity: 1 }], payments: [{ method: "card", amount: Number(item.sellPrice), reference: "AUTH-S5" }] },
  });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).saleNumber as string;
}

test.describe("sprint 5: exchanges, voids, exports", () => {
  test("setup: products and a card-paid invoice", async ({ page }) => {
    await login(page, "manager");
    for (const [sku, code, price] of [["S5-A", CODE_A, 500], ["S5-B", CODE_B, 800]] as const) {
      const res = await page.request.post("/api/v1/products", {
        data: { name: `S5 ${sku}`, unit: "pcs", trackStock: true, variants: [{ sku, barcodes: [code], costPrice: 200, sellPrice: price, reorderLevel: 1, openingStock: 10 }] },
      });
      expect(res.ok()).toBeTruthy();
    }
    regId = (await (await page.request.get("/api/v1/registers")).json())[0].id;
    invoice = await cardSale(page, CODE_A);
    expect(await onHand(page, CODE_A)).toBe(9);
  });

  test("manager exchanges an item for a dearer one, pays the difference and gets a receipt", async ({ page }) => {
    await login(page, "manager");
    await nav(page, "Exchanges");
    await page.getByLabel("Original invoice number").fill(invoice);
    await page.getByRole("button", { name: "Find invoice" }).click();
    const form = page.getByTestId("exchange-form");
    await expect(form).toContainText(invoice);
    await form.getByLabel(/^Return quantity for/).fill("1");
    await form.getByLabel(/^Resellable/).check();
    await form.getByLabel("Search replacement").fill(CODE_B);
    await form.getByTestId("exchange-results").getByRole("button").first().click();
    await expect(page.getByTestId("exchange-difference")).toHaveText("Rs. 300.00");
    await form.getByLabel("Settlement method").selectOption("card");
    await form.getByLabel("Payment reference").fill("AUTH-EX1");
    await shot(page, "25-exchange");
    await page.getByTestId("complete-exchange").click();
    const receipt = page.getByTestId("exchange-receipt").first();
    await expect(receipt).toContainText("EXCHANGE");
    await expect(receipt).toContainText(invoice);
    await expect(receipt).toContainText("300.00");
    await shot(page, "26-exchange-receipt");
    expect(await onHand(page, CODE_A)).toBe(10); // resellable item restocked
    expect(await onHand(page, CODE_B)).toBe(9);
  });

  test("cashier cannot reach exchanges", async ({ page }) => {
    await login(page, "cashier");
    await expect(page.getByRole("navigation", { name: "Main", exact: true }).getByRole("link", { name: "Exchanges" })).toHaveCount(0);
    await page.goto("/exchanges");
    await expect(page).toHaveURL(/\/pos$/);
  });

  test("held sale is voided by a manager with a reason; completed sales cannot be voided", async ({ page }) => {
    await login(page, "cashier");
    const item = await (await page.request.get(`/api/v1/products/lookup/${CODE_B}`)).json();
    const held = await page.request.post("/api/v1/sales/hold", { data: { id: crypto.randomUUID(), registerId: regId, items: [{ variantId: item.id, quantity: 2 }] } });
    expect(held.status()).toBe(201);
    heldNumber = (await held.json()).saleNumber;
    // Cashiers have no void permission
    const forbidden = await page.request.post(`/api/v1/sales/${(await held.json()).id}/void`, { data: { reason: "not allowed" } });
    expect(forbidden.status()).toBe(403);

    await page.context().clearCookies();
    await login(page, "manager");
    await nav(page, "Sales");
    await page.getByLabel("Status").selectOption("HELD");
    await page.getByTestId(`void-${heldNumber}`).click();
    const dlg = page.getByRole("dialog", { name: new RegExp(`Void ${heldNumber}`) });
    await expect(dlg.getByRole("button", { name: "Void sale" })).toBeDisabled();
    await dlg.getByLabel("Reason (required)").fill("Customer left the store");
    await shot(page, "27-void");
    await dlg.getByRole("button", { name: "Void sale" }).click();
    await expect(page.getByTestId(`void-${heldNumber}`)).toHaveCount(0);
    expect(await onHand(page, CODE_B)).toBe(9); // held cart never touched stock

    const completed = await (await page.request.get("/api/v1/sales?search=" + invoice)).json();
    const res = await page.request.post(`/api/v1/sales/${completed.items[0].id}/void`, { data: { reason: "try to void completed" } });
    expect(res.status()).toBe(409);
  });

  test("manager downloads CSV and PDF exports; cashiers cannot", async ({ page }) => {
    await login(page, "manager");
    await nav(page, "Reports");
    const bar = page.getByTestId("export-bar");
    await bar.getByLabel("Export").selectOption("sales");
    const [csv] = await Promise.all([page.waitForEvent("download"), bar.getByRole("button", { name: "CSV" }).click()]);
    expect(csv.suggestedFilename()).toMatch(/\.csv$/);
    const path = await csv.path();
    const text = (await import("node:fs")).readFileSync(path, "utf8");
    expect(text).toContain("Net sales");
    await bar.getByLabel("Export").selectOption("products");
    const [pdf] = await Promise.all([page.waitForEvent("download"), bar.getByRole("button", { name: "PDF" }).click()]);
    expect(pdf.suggestedFilename()).toMatch(/\.pdf$/);
    expect((await import("node:fs")).readFileSync((await pdf.path())!).subarray(0, 4).toString()).toBe("%PDF");
    await shot(page, "28-exports");

    await page.context().clearCookies();
    await login(page, "cashier");
    expect((await page.request.get("/api/v1/exports/sales.csv")).status()).toBe(403);
  });

  test("health endpoints are public and leak nothing", async ({ request }) => {
    const h = await request.get("http://localhost:4100/health");
    expect(h.ok()).toBeTruthy();
    const r = await request.get("http://localhost:4100/ready");
    expect(r.ok()).toBeTruthy();
    expect(JSON.stringify(await r.json())).not.toMatch(/postgres(ql)?:\/\//i);
  });
});

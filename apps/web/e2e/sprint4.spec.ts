import { expect, test, type Page } from "@playwright/test";
import { login, onHand, openPayment, scan, shot } from "./helpers";

const BARCODE = "9990000000100";
const nav = (page: Page, name: string) => page.getByRole("navigation", { name: "Main", exact: true }).getByRole("link", { name }).click();

test.describe.configure({ mode: "serial" });

let invoice = "";

test.describe("sprint 4: shifts, returns, reports, variants, customers", () => {
  test("setup: manager creates a product with stock", async ({ page }) => {
    await login(page, "manager");
    const res = await page.request.post("/api/v1/products", {
      data: { name: "S4 Widget", unit: "pcs", trackStock: true, variants: [{ sku: "S4-W1", barcodes: [BARCODE], costPrice: 300, sellPrice: 500, reorderLevel: 2, openingStock: 20 }] },
    });
    expect(res.ok()).toBeTruthy();
    expect(await onHand(page, BARCODE)).toBe(20);
  });

  test("cashier opens a shift, sells to a registered customer and records cash in", async ({ page }) => {
    await login(page, "cashier");
    await page.goto("/pos");
    await expect(page.getByTestId("shift-banner")).toContainText("No open shift");

    await nav(page, "Shifts");
    await page.getByLabel("Opening cash (Rs.)").fill("1000");
    await page.getByRole("button", { name: "Open shift" }).click();
    const drawer = page.getByTestId("drawer-summary");
    await expect(drawer).toContainText("Rs. 1,000.00");

    // Overlapping shift on the same register is refused by the server
    const dup = await page.request.post("/api/v1/shifts", { data: { registerId: Number(await page.evaluate(() => localStorage.getItem("pos.register") ?? "0")) || 1, openingCash: 0 } });
    expect(dup.ok()).toBeFalsy();

    await page.getByRole("button", { name: "Cash in" }).click();
    const cin = page.getByRole("dialog", { name: "Cash in" });
    await cin.getByLabel("Amount (Rs.)").fill("200");
    await cin.getByLabel("Reason").fill("Float top-up");
    await cin.getByRole("button", { name: "Save" }).or(cin.locator("button[type=submit]")).first().click();
    await expect(drawer).toContainText("Rs. 1,200.00");
    await shot(page, "16-shift-open");

    await nav(page, "Checkout");
    await expect(page.getByTestId("shift-banner")).toBeHidden();
    await scan(page, BARCODE);
    await expect(page.getByTestId("cart-total")).toHaveText("Rs. 500.00");
    await scan(page, BARCODE);
    await expect(page.getByTestId("cart-total")).toHaveText("Rs. 1,000.00");
    await page.getByRole("button", { name: "Add customer" }).click();
    const pick = page.getByRole("dialog", { name: "Attach customer" });
    await pick.getByRole("button", { name: "New customer" }).click();
    const form = page.getByRole("dialog", { name: "New customer" });
    await form.getByLabel("Name").fill("Nimal Perera");
    await form.getByLabel("Phone").fill("0771234567");
    await form.locator("button[type=submit]").click();
    await expect(page.getByTestId("customer-picker")).toContainText("Nimal Perera");

    const pay = await openPayment(page);
    await expect(pay.getByTestId("amount-due")).toHaveText("Rs. 1,000.00");
    await pay.getByLabel("Cash received").fill("1000");
    await pay.getByRole("button", { name: /^Complete/ }).click();
    const receipt = page.getByRole("dialog", { name: "Sale complete" }).getByTestId("receipt");
    await expect(receipt).toContainText(/INV-\d{6}/);
    invoice = (await receipt.innerText()).match(/INV-\d{6}/)![0];
    await page.getByRole("button", { name: "New sale" }).click();
    expect(await onHand(page, BARCODE)).toBe(18);
  });

  test("cashier cannot see or use returns and reports", async ({ page }) => {
    await login(page, "cashier");
    const links = page.getByRole("navigation", { name: "Main", exact: true });
    await expect(links.getByRole("link", { name: "Returns" })).toHaveCount(0);
    await expect(links.getByRole("link", { name: "Reports" })).toHaveCount(0);
    await page.goto("/returns");
    await expect(page).toHaveURL(/\/pos$/);
    const res = await page.request.get("/api/v1/reports/sales");
    expect(res.status()).toBe(403);
  });

  test("manager processes a partial cash return, then a card refund that stays pending until confirmed", async ({ page }) => {
    await login(page, "manager");
    await nav(page, "Returns");
    await page.getByLabel("Original invoice number").fill(invoice);
    await page.getByRole("button", { name: "Find invoice" }).click();
    const line = page.getByTestId("return-line").first();
    await expect(line).toContainText("S4 Widget");
    await line.getByLabel("Return quantity for S4 Widget").fill("1");
    await line.getByLabel("Resellable S4 Widget").check();
    await expect(page.getByTestId("refund-total")).toContainText("Rs. 500.00");
    await page.getByLabel("Reason").selectOption("CHANGED_MIND");
    await shot(page, "17-return-form");
    await page.getByRole("button", { name: "Process refund" }).click();
    const rr = page.getByRole("dialog", { name: "Refund receipt" });
    await expect(rr.getByTestId("refund-receipt")).toContainText("Rs. 500.00");
    await shot(page, "17b-refund-receipt");
    await rr.getByRole("button", { name: "Close" }).last().click();
    await expect(page.getByRole("tab", { name: "Return history", selected: true })).toBeVisible();
    await expect(page.getByTestId("returns-table")).toContainText(invoice);
    expect(await onHand(page, BARCODE)).toBe(19);

    // The refund method must match how the invoice was paid
    await page.getByRole("tab", { name: "New return" }).click();
    await page.getByLabel("Original invoice number").fill(invoice);
    await page.getByRole("button", { name: "Find invoice" }).click();
    const l2 = page.getByTestId("return-line").first();
    await l2.getByLabel("Return quantity for S4 Widget").fill("1");
    await page.getByLabel("Refund method").selectOption("card");
    await page.getByLabel("Refund reference").fill("CARD-REV-0");
    await page.getByRole("button", { name: "Process refund" }).click();
    await expect(page.getByText(/Card refunds cannot exceed Rs. 0.00/)).toBeVisible();
    await page.getByLabel("Refund method").selectOption("cash");
    await page.getByLabel("Reason").selectOption("DAMAGED");
    await page.getByRole("button", { name: "Process refund" }).click();
    await page.getByRole("dialog", { name: "Refund receipt" }).getByRole("button", { name: "Close" }).last().click();
    expect(await onHand(page, BARCODE)).toBe(19); // damaged: not restocked

    // A fully returned invoice cannot be returned again
    await page.getByRole("tab", { name: "New return" }).click();
    await page.getByLabel("Original invoice number").fill(invoice);
    await page.getByRole("button", { name: "Find invoice" }).click();
    await expect(page.getByText("Fully returned")).toBeVisible();

    // Card-paid sale: its refund stays pending until the provider confirms
    const item = await (await page.request.get(`/api/v1/products/lookup/${BARCODE}`)).json();
    const regs = await (await page.request.get("/api/v1/registers")).json();
    const card = await page.request.post("/api/v1/sales", {
      data: { id: crypto.randomUUID(), registerId: regs[0].id, items: [{ variantId: item.id, quantity: 1 }], payments: [{ method: "card", amount: 500, reference: "AUTH-S4" }] },
    });
    expect(card.ok()).toBeTruthy();
    const cardInvoice = (await card.json()).saleNumber as string;
    expect(await onHand(page, BARCODE)).toBe(18);
    await page.getByRole("tab", { name: "New return" }).click();
    await page.getByLabel("Original invoice number").fill(cardInvoice);
    await page.getByRole("button", { name: "Find invoice" }).click();
    await page.getByTestId("return-line").first().getByLabel("Return quantity for S4 Widget").fill("1");
    await page.getByLabel("Reason").selectOption("DEFECTIVE");
    await page.getByLabel("Refund reference").fill("CARD-REV-1");
    await page.getByRole("button", { name: "Process refund" }).click();
    await page.getByRole("dialog", { name: "Refund receipt" }).getByRole("button", { name: "Close" }).last().click();
    await expect(page.getByTestId("returns-table")).toContainText(/pending/i);
    await shot(page, "18-return-history");

    await page.getByRole("button", { name: "Confirm", exact: true }).first().click();
    const dlg = page.getByRole("dialog", { name: "Confirm refund" });
    await dlg.getByLabel("Provider reference").fill("PROV-OK-1");
    await dlg.getByRole("button", { name: "Confirm refund" }).click();
    await expect(page.getByTestId("returns-table")).not.toContainText(/pending/i);
  });

  test("cashier closes the shift with a shortage; manager approves it", async ({ page, browser }) => {
    await login(page, "cashier");
    await nav(page, "Shifts");
    await page.getByRole("button", { name: "Close shift" }).click();
    const dlg = page.getByRole("dialog", { name: "Close shift" });
    await dlg.getByLabel("Counted cash (Rs.)").fill("1150");
    await dlg.getByLabel(/Notes/).fill("Counted twice");
    await dlg.getByRole("button", { name: "Close shift" }).click();
    const result = page.getByTestId("close-result");
    // 1,000 opening + 1,000 sales + 200 cash in - 2 x 500 cash refunds = 1,200 expected; card refund excluded
    await expect(result).toContainText("Rs. 1,200.00");
    await expect(result).toContainText("Shortage");
    await shot(page, "19-shift-closed");
    await page.getByRole("button", { name: "Done" }).click();

    const ctx = await browser.newContext();
    const mgr = await ctx.newPage();
    await login(mgr, "manager");
    await nav(mgr, "Shifts");
    await mgr.getByTestId("shift-history").getByRole("button", { name: /Details|View|Review/ }).first().click();
    await mgr.getByLabel("Approval note").fill("Recount confirmed");
    await mgr.getByRole("button", { name: /Approve/ }).click();
    await expect(mgr.getByText(/Approved|approved/).first()).toBeVisible();
    await ctx.close();
  });

  test("reports reflect sales, refunds and the shift shortage", async ({ page }) => {
    await login(page, "manager");
    await nav(page, "Reports");
    const sales = page.getByTestId("report-sales");
    await expect(sales).toContainText("Net sales");
    await expect(sales).toContainText("Rs. 1,500.00"); // 2 cash units + 1 card unit
    await expect(sales).toContainText("3 returns");
    await expect(sales.getByRole("row").nth(1)).toContainText("Rs. 0.00"); // everything sold was returned: net sales nil
    await shot(page, "20-reports-sales");

    await page.getByRole("tab", { name: "Payments" }).click();
    await expect(page.getByTestId("report-payments")).toContainText("Cash");
    await page.getByRole("tab", { name: "Products" }).click();
    await expect(page.getByTestId("report-products")).toContainText("S4 Widget");
    await page.getByRole("tab", { name: "Shift reconciliation" }).click();
    await expect(page.getByTestId("report-shifts")).toContainText("Rs. 50.00");
    await shot(page, "21-reports-shifts");
  });

  test("customer purchase history shows the linked invoice and its returns", async ({ page }) => {
    await login(page, "manager");
    await nav(page, "Customers");
    await page.getByLabel("Search customers").fill("Nimal");
    await shot(page, "22-customers");
    await page.getByRole("button", { name: "Purchases" }).first().click();
    const h = page.getByTestId("customer-history");
    await expect(h).toContainText(invoice);
    await expect(h).toContainText("Rs. 1,000.00");
  });

  test("manager edits a variant and adds a second one; stock is unchanged", async ({ page }) => {
    await login(page, "manager");
    await nav(page, "Products");
    await page.getByLabel("Search products").fill("S4 Widget");
    await page.getByRole("button", { name: "Edit S4 Widget" }).click();
    const dlg = page.getByRole("dialog", { name: "Edit product" });
    await dlg.getByRole("button", { name: "Edit variant S4-W1" }).click();
    await dlg.getByLabel("Variant name").fill("Standard");
    await dlg.getByLabel("Variant selling price (Rs.)").fill("550");
    await dlg.getByLabel("Variant barcodes").fill(`${BARCODE}, 9990000000101`);
    await dlg.getByRole("button", { name: "Save variant" }).click();
    await expect(dlg.getByTestId("variants-manager")).toContainText("Rs. 550.00");

    await dlg.getByRole("button", { name: "Add variant" }).click();
    await dlg.getByLabel("Variant name").fill("Large");
    await dlg.getByLabel("Variant SKU").fill("S4-W2");
    await dlg.getByLabel("Variant selling price (Rs.)").fill("900");
    await dlg.getByLabel("Opening stock").fill("5");
    await dlg.getByRole("button", { name: "Save variant" }).click();
    await expect(dlg.getByTestId("variant-row")).toHaveCount(2);
    await shot(page, "23-variants");

    expect(await onHand(page, "9990000000101")).toBe(18);
    // History keeps the price the item was sold at
    const sale = await page.request.get("/api/v1/sales", { params: { search: invoice } });
    const body = await sale.json();
    const id = body.items[0].id;
    const detail = await (await page.request.get(`/api/v1/sales/${id}`)).json();
    expect(Number(detail.items[0].unitPrice)).toBe(500);
  });
});

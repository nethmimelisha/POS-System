import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { CODES, login, onHand, openPayment, scan, SHOTS, shot } from "./helpers";

test.describe("checkout against the real API and database", () => {
  test("full cashier journey: login, scan, search, discount, split payment, receipt, print, stock, logout", async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __prints: number }).__prints = 0;
      window.print = () => {
        (window as unknown as { __prints: number }).__prints++;
      };
    });
    await login(page, "cashier");
    const riceBefore = await onHand(page, CODES.rice);
    const teaBefore = await onHand(page, CODES.tea);
    await shot(page, "02-pos-empty");

    // Barcode scan (keyboard-wedge style: type + Enter)
    await scan(page, CODES.rice);
    await expect(page.getByTestId("cart-line")).toHaveCount(1);
    await expect(page.getByTestId("cart-total")).toHaveText("Rs. 450.00");

    // Search by name, then add from the results grid
    await page.getByTestId("scan-input").fill("ceylon tea");
    await page.getByTestId("search-results").getByRole("button", { name: /Ceylon Tea 200g/ }).click();
    await expect(page.getByTestId("cart-line")).toHaveCount(2);

    // Quantity control: rice x2
    await page.getByRole("button", { name: "Increase Basmati Rice 1kg" }).click();
    await expect(page.getByTestId("cart-total")).toHaveText("Rs. 1,680.00");

    // Line discount 10% on tea (780 -> 702)
    await page.getByRole("button", { name: "Discount for Ceylon Tea 200g" }).click();
    let dlg = page.getByRole("dialog", { name: "Item discount" });
    await dlg.getByLabel("Percentage").fill("10");
    await dlg.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByTestId("cart-total")).toHaveText("Rs. 1,602.00");

    // Cashier may not give a 20% sale discount: the server refuses and checkout is blocked
    await page.getByRole("button", { name: "Add sale discount" }).click();
    dlg = page.getByRole("dialog", { name: "Sale discount" });
    await dlg.getByLabel("Percentage").fill("20");
    await dlg.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByRole("alert").filter({ hasText: /manager approval/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Charge/ })).toBeDisabled();
    await shot(page, "03-pos-discount-rejected");

    // Remove it again
    await page.getByRole("button", { name: /Sale discount \(20%\)/ }).click();
    await page.getByRole("dialog", { name: "Sale discount" }).getByRole("button", { name: "Remove" }).click();
    await expect(page.getByTestId("cart-total")).toHaveText("Rs. 1,602.00");
    await shot(page, "04-pos-cart");

    // Split payment: cash 1,000 + card for the remaining 602
    const pay = await openPayment(page);
    await expect(pay.getByTestId("amount-due")).toHaveText("Rs. 1,602.00");
    await pay.getByLabel("Cash received").fill("1000");
    await expect(pay.getByTestId("remaining")).toHaveText("Rs. 602.00");
    await expect(pay.getByRole("button", { name: /^Complete/ })).toBeDisabled();
    await pay.getByRole("button", { name: "Split payment" }).click();
    await expect(pay.getByLabel("Amount")).toHaveValue("602");
    await expect(pay.getByRole("button", { name: /^Complete/ })).toBeDisabled(); // card needs a reference
    await pay.getByLabel("Card slip / auth no.").fill("AUTH-7788");
    await expect(pay.getByTestId("change")).toHaveText("Rs. 0.00");
    await shot(page, "05-payment-split");
    await pay.getByRole("button", { name: /^Complete/ }).click();

    // Receipt
    const receiptDlg = page.getByRole("dialog", { name: "Sale complete" });
    const receipt = receiptDlg.getByTestId("receipt");
    await expect(receipt).toBeVisible();
    await expect(receipt).toContainText(/INV-\d{6}/);
    await expect(receipt).toContainText("Basmati Rice 1kg");
    await expect(receipt).toContainText("2 x Rs. 450.00");
    await expect(receipt).toContainText("Ceylon Tea 200g");
    await expect(receipt).toContainText("TOTAL");
    await expect(receipt).toContainText("Rs. 1,602.00");
    await expect(receipt).toContainText("AUTH-7788");
    await expect(receipt).not.toContainText("VAT"); // tax is disabled by default
    await shot(page, "06-receipt");

    // The cart is cleared only after success
    await receiptDlg.getByRole("button", { name: "Print receipt" }).click();
    expect(await page.evaluate(() => (window as unknown as { __prints: number }).__prints)).toBe(1);

    // 80 mm print layout
    await page.emulateMedia({ media: "print" });
    const printed = page.locator("#print-root .receipt");
    await expect(printed).toBeVisible();
    const box = (await printed.boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(80 * (96 / 25.4) + 1); // 80 mm in CSS px
    await expect(page.getByRole("dialog")).toBeHidden();
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.pdf({ path: path.join(SHOTS, "receipt-80mm.pdf"), width: "80mm", printBackground: true });
    await page.emulateMedia({ media: "screen" });

    await receiptDlg.getByRole("button", { name: "New sale" }).click();
    await expect(page.getByTestId("cart-line")).toHaveCount(0);

    // Inventory reduced in the real database
    expect(await onHand(page, CODES.rice)).toBe(riceBefore - 2);
    expect(await onHand(page, CODES.tea)).toBe(teaBefore - 1);

    // Dashboard reflects the sale
    await page.getByRole("link", { name: "Dashboard" }).click();
    await expect(page.getByTestId("dashboard-stats")).toContainText("Rs. 1,602.00");
    await shot(page, "07-dashboard-cashier");

    // Logout
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test("cash payment gives change; underpayment cannot be submitted", async ({ page }) => {
    await login(page, "cashier");
    const before = await onHand(page, CODES.water);
    await scan(page, `3*${CODES.water}`);
    await expect(page.getByTestId("cart-total")).toHaveText("Rs. 300.00");
    const pay = await openPayment(page);
    await pay.getByLabel("Cash received").fill("100");
    await expect(pay.getByTestId("remaining")).toHaveText("Rs. 200.00");
    await expect(pay.getByRole("button", { name: /^Complete/ })).toBeDisabled();
    await pay.getByLabel("Cash received").fill("500");
    await expect(pay.getByTestId("change")).toHaveText("Rs. 200.00");
    await pay.getByRole("button", { name: /^Complete/ }).click();
    await expect(page.getByRole("dialog", { name: "Sale complete" }).getByTestId("receipt")).toContainText("Rs. 200.00");
    expect(await onHand(page, CODES.water)).toBe(before - 3);
  });

  test("insufficient stock is flagged and blocks checkout without clearing the cart", async ({ page }) => {
    await login(page, "cashier");
    const before = await onHand(page, CODES.book);
    await scan(page, `99*${CODES.book}`);
    await expect(page.getByText(/Only \d+ in stock/)).toBeVisible();
    await expect(page.getByRole("button", { name: /^Charge/ })).toBeDisabled();
    await expect(page.getByTestId("cart-line")).toHaveCount(1);
    expect(await onHand(page, CODES.book)).toBe(before);
    await shot(page, "08-insufficient-stock");
  });

  test("unknown barcode shows a helpful message", async ({ page }) => {
    await login(page, "cashier");
    await scan(page, "0000000000000");
    await expect(page.getByText(/No exact barcode or SKU match/)).toBeVisible();
    await expect(page.getByTestId("cart-line")).toHaveCount(0);
  });

  test("request never reaches the server: cart kept, status check unlocks, retry works", async ({ page }) => {
    await login(page, "cashier");
    const before = await onHand(page, CODES.water);
    await scan(page, CODES.water);
    let blocked = true;
    await page.route("**/api/v1/sales", (route) => (blocked && route.request().method() === "POST" ? route.abort("connectionreset") : route.continue()));
    const pay = await openPayment(page);
    await pay.getByRole("button", { name: /^Complete/ }).click();
    await expect(pay.getByRole("alert")).toContainText(/Connection lost/);
    await expect(pay.getByRole("button", { name: "Retry payment" })).toBeVisible();
    await shot(page, "09-network-failure");

    await pay.getByRole("button", { name: "Check status" }).click(); // 404: nothing was recorded
    await expect(pay.getByRole("alert")).toContainText(/not recorded/);
    expect(await onHand(page, CODES.water)).toBe(before);

    blocked = false;
    await pay.getByRole("button", { name: /^Complete/ }).click();
    await expect(page.getByRole("dialog", { name: "Sale complete" })).toBeVisible();
    expect(await onHand(page, CODES.water)).toBe(before - 1);
  });

  test("response lost after the server committed: retry replays the same sale (no duplicate)", async ({ page }) => {
    await login(page, "cashier");
    const before = await onHand(page, CODES.water);
    await scan(page, CODES.water);
    let dropResponse = true;
    await page.route("**/api/v1/sales", async (route) => {
      if (dropResponse && route.request().method() === "POST") {
        await route.fetch(); // the server processes and commits the sale
        dropResponse = false;
        await route.abort("connectionreset"); // ...but the browser never sees the answer
      } else {
        await route.continue();
      }
    });
    const pay = await openPayment(page);
    await pay.getByRole("button", { name: /^Complete/ }).click();
    await expect(pay.getByRole("alert")).toContainText(/Connection lost/);
    expect(await onHand(page, CODES.water)).toBe(before - 1); // it really was recorded

    await pay.getByRole("button", { name: "Retry payment" }).click();
    await expect(page.getByRole("dialog", { name: "Sale complete" }).getByTestId("receipt")).toContainText(/INV-\d{6}/);
    expect(await onHand(page, CODES.water)).toBe(before - 1); // still exactly one deduction
  });

  test("expired session redirects to login and keeps the cart", async ({ page, context }) => {
    await login(page, "cashier");
    await scan(page, CODES.dhal);
    await expect(page.getByTestId("cart-line")).toHaveCount(1);
    await context.clearCookies(); // simulates server-side expiry
    await page.getByRole("button", { name: "Increase Red Lentils 500g" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByText(/session expired/i)).toBeVisible();
    await page.getByLabel("Username").fill("cashier");
    await page.getByLabel("Password").fill("Demo12345!");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/pos$/);
    await expect(page.getByTestId("cart-line")).toHaveCount(1);
  });

  test("tablet layout works without horizontal scrolling", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await login(page, "cashier");
    await scan(page, CODES.oil);
    await expect(page.getByTestId("cart-line")).toHaveCount(1);
    await page.getByTestId("scan-input").fill("rice");
    await expect(page.getByTestId("search-results")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await shot(page, "10-pos-tablet");
  });
});

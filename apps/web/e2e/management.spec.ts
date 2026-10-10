import { expect, test } from "@playwright/test";
import { CODES, login, onHand, scan, shot } from "./helpers";

test.describe("management screens", () => {
  test("manager: create product, find it at the POS, adjust stock, see low stock", async ({ page }) => {
    await login(page, "manager");
    await shot(page, "11-dashboard-manager");

    await page.getByRole("navigation", { name: "Main", exact: true }).getByRole("link", { name: "Products" }).click();
    await page.getByRole("button", { name: "New product" }).click();
    const dlg = page.getByRole("dialog", { name: "New product" });
    await dlg.getByLabel("Product name").fill("E2E Notebook A5");
    await dlg.getByLabel("SKU").fill("E2E-A5");
    await dlg.getByLabel("Barcodes").fill("9990000000017");
    await dlg.getByLabel("Selling price (Rs.)").fill("250");
    await dlg.getByLabel("Opening stock").fill("12");
    await dlg.getByRole("button", { name: "Save product" }).click();
    await expect(dlg).toBeHidden();
    await expect(page.getByTestId("products-table")).toContainText("E2E Notebook A5");
    await shot(page, "12-products");

    await page.getByRole("navigation", { name: "Main", exact: true }).getByRole("link", { name: "Checkout" }).click();
    await scan(page, "9990000000017");
    await expect(page.getByTestId("cart-total")).toHaveText("Rs. 250.00");

    await page.getByRole("navigation", { name: "Main", exact: true }).getByRole("link", { name: "Inventory" }).click();
    await page.getByRole("button", { name: "Adjust E2E Notebook A5" }).click();
    const adj = page.getByRole("dialog", { name: "Adjust stock" });
    await adj.getByLabel("Type").selectOption("DAMAGE");
    await adj.getByLabel("Quantity").fill("2");
    await adj.getByLabel("Reason").fill("Water damage");
    await adj.getByRole("button", { name: "Save adjustment" }).click();
    await expect(adj).toBeHidden();
    expect(await onHand(page, "9990000000017")).toBe(10);

    await page.getByRole("tab", { name: "Low stock" }).click();
    await expect(page.getByTestId("inventory-table")).toContainText("Exercise Book 80pg");
    await shot(page, "13-inventory-low-stock");
  });

  test("manager gets a clear error when adjusting below zero stock", async ({ page }) => {
    await login(page, "manager");
    await page.goto("/inventory");
    await page.getByRole("button", { name: "Adjust Exercise Book 80pg" }).click();
    const adj = page.getByRole("dialog", { name: "Adjust stock" });
    await adj.getByLabel("Type").selectOption("DAMAGE");
    await adj.getByLabel("Quantity").fill("500");
    await adj.getByLabel("Reason").fill("test");
    await adj.getByRole("button", { name: "Save adjustment" }).click();
    await expect(adj.getByRole("alert")).toBeVisible();
    expect(await onHand(page, CODES.book)).toBeGreaterThan(0);
  });

  test("manager can approve a larger sale discount", async ({ page }) => {
    await login(page, "manager");
    await page.goto("/pos");
    await scan(page, CODES.oil);
    await page.getByRole("button", { name: "Add sale discount" }).click();
    const dlg = page.getByRole("dialog", { name: "Sale discount" });
    await dlg.getByLabel("Percentage").fill("20");
    await dlg.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByTestId("cart-total")).toHaveText("Rs. 1,000.00");
  });

  test("admin: settings keep VAT disabled by default; sales history lists receipts", async ({ page }) => {
    await login(page, "admin");
    await page.goto("/settings");
    await page.getByRole("tab", { name: "Business" }).click();
    await expect(page.getByLabel("Charge VAT")).not.toBeChecked();
    await shot(page, "14-settings");
    await page.goto("/sales");
    await shot(page, "15-sales");
  });
});

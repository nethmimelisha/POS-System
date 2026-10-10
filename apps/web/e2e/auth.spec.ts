import { expect, test } from "@playwright/test";
import { login, shot, USERS } from "./helpers";

test.describe("authentication and role-based access", () => {
  test("anonymous users are sent to the login screen", async ({ page }) => {
    await page.goto("/pos");
    await expect(page).toHaveURL(/\/login$/);
    await shot(page, "01-login");
  });

  test("wrong password shows an error and stays on login", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Username").fill("cashier");
    await page.getByLabel("Password").fill("not-the-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toContainText(/invalid|incorrect/i);
    await expect(page).toHaveURL(/\/login$/);
  });

  test("cashier: checkout access only, no token in web storage, cookie is HttpOnly", async ({ page, context }) => {
    await login(page, "cashier");
    const nav = page.getByRole("navigation", { name: "Main", exact: true });
    await expect(nav.getByRole("link", { name: "Checkout" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Products" })).toHaveCount(0);
    await expect(nav.getByRole("link", { name: "Inventory" })).toHaveCount(0);

    await page.goto("/products");
    await expect(page).toHaveURL(/\/pos$/); // blocked route redirects to the cashier's home

    const cookie = (await context.cookies()).find((c) => c.name === "pos_session");
    expect(cookie?.httpOnly).toBe(true);
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
    expect(stored).not.toContain(cookie!.value);
    expect(stored.toLowerCase()).not.toContain("token");
  });

  test("manager sees products and inventory but not user management", async ({ page }) => {
    await login(page, "manager");
    const nav = page.getByRole("navigation", { name: "Main", exact: true });
    await expect(nav.getByRole("link", { name: "Products" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Inventory" })).toBeVisible();
    await page.goto("/settings");
    await expect(page.getByRole("tab", { name: "Users" })).toHaveCount(0);
  });

  test("admin can manage users", async ({ page }) => {
    await login(page, "admin");
    await page.goto("/settings");
    await page.getByRole("tab", { name: "Users" }).click();
    const table = page.getByTestId("users-table");
    for (const u of Object.values(USERS)) await expect(table).toContainText(u.username);
  });

  test("logout ends the session and protects routes again", async ({ page }) => {
    await login(page, "cashier");
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto("/pos");
    await expect(page).toHaveURL(/\/login$/);
    const me = await page.request.get("/api/v1/auth/me");
    expect(me.status()).toBe(401);
  });
});

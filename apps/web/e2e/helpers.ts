import path from "node:path";
import { expect, type Page } from "@playwright/test";

export const SHOTS = path.resolve(import.meta.dirname, "../../../docs/screenshots");
export const DEMO_PASSWORD = "Demo12345!";
export const ADMIN_PASSWORD = "Admin12345!";

export const CODES = {
  rice: "4791000000011",
  dhal: "4791000000028",
  oil: "4791000000035",
  tea: "4791000000042",
  book: "4791000000059",
  water: "4791000000066",
};

export const USERS = {
  admin: { username: "admin", password: ADMIN_PASSWORD },
  manager: { username: "manager", password: DEMO_PASSWORD },
  cashier: { username: "cashier", password: DEMO_PASSWORD },
};

export async function login(page: Page, who: keyof typeof USERS, landing?: RegExp) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(USERS[who].username);
  await page.getByLabel("Password").fill(USERS[who].password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(landing ?? (who === "cashier" ? /\/pos$/ : /\/dashboard$/));
}

export async function scan(page: Page, text: string) {
  const box = page.getByTestId("scan-input");
  await box.fill(text);
  await box.press("Enter");
}

export async function onHand(page: Page, code: string): Promise<number> {
  const res = await page.request.get(`/api/v1/products/lookup/${code}`);
  expect(res.ok()).toBeTruthy();
  return Number((await res.json()).stockLevel.onHand);
}

export async function openPayment(page: Page) {
  await page.getByRole("button", { name: /^Charge/ }).click();
  const dialog = page.getByRole("dialog", { name: "Payment" });
  await expect(dialog).toBeVisible();
  return dialog;
}

export async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

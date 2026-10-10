import { describe, expect, it } from "vitest";
import { NAV_ITEMS } from "./nav";

const visible = (role: "ADMIN" | "MANAGER" | "CASHIER") => NAV_ITEMS.filter((i) => i.roles.includes(role)).map((i) => i.to);

describe("role-based navigation", () => {
  it("hides management screens from cashiers", () => {
    expect(visible("CASHIER")).toEqual(["/pos", "/dashboard", "/sales", "/shifts", "/customers", "/settings"]);
  });
  it("shows products and inventory to managers and admins", () => {
    for (const r of ["MANAGER", "ADMIN"] as const) expect(visible(r)).toEqual(expect.arrayContaining(["/products", "/inventory", "/returns", "/reports"]));
  });
});

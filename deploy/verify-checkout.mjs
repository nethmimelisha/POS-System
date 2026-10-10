// Runs inside the api container: node - < deploy/verify-checkout.mjs
const BASE = "http://127.0.0.1:4000";
const H = { "content-type": "application/json", "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.9" };
let cookie = "";
async function call(method, path, body, extra = {}) {
  const r = await fetch(BASE + path, { method, headers: { ...H, ...(cookie ? { cookie } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.getSetCookie?.() ?? [];
  if (sc.length) cookie = sc.map((c) => c.split(";")[0]).join("; ");
  let json = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, json, headers: r.headers, setCookie: sc };
}
const must = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exit(1); } console.log("PASS:", msg); };

const health = await call("GET", "/health");
must(health.status === 200, "GET /health 200");
const ready = await call("GET", "/ready");
must(ready.status === 200, "GET /ready 200 " + JSON.stringify(ready.json));

const bad = await call("POST", "/auth/login", { username: "owner", password: "wrong-password-xyz" });
must(bad.status === 401, "wrong password rejected (401)");
const login = await call("POST", "/auth/login", { username: "owner", password: process.env.VERIFY_ADMIN_PASSWORD });
must(login.status === 200, "admin login 200");
const flags = (login.setCookie[0] ?? "").toLowerCase();
must(flags.includes("httponly") && flags.includes("secure") && flags.includes("samesite"), "session cookie is HttpOnly + Secure + SameSite");

const regs = (await call("GET", "/registers")).json;
must(Array.isArray(regs) && regs.length > 0, "registers seeded by migrate job (" + (regs?.length ?? 0) + ")");
const pms = (await call("GET", "/payment-methods")).json;
must(Array.isArray(pms) && pms.some((p) => p.code === "cash"), "cash payment method seeded");

const tag = Date.now().toString(36);
const barcode = "99" + String(Date.now()).slice(-10);
const created = await call("POST", "/products", { name: `Docker Verify ${tag}`, unit: "pcs", trackStock: true, variants: [{ sku: `DV-${tag}`, barcodes: [barcode], costPrice: 50, sellPrice: 100, reorderLevel: 1, openingStock: 10 }] });
must(created.status === 201, "product created");
const variantId = created.json.variants[0].id;
const found = await call("GET", `/products?search=${encodeURIComponent("Docker Verify " + tag)}`);
must(JSON.stringify(found.json).includes(variantId), "product search finds it");
const lookup = await call("GET", `/products/lookup/${barcode}`);
must(lookup.status === 200 && Number(lookup.json.stockLevel.onHand) === 10, "barcode lookup shows 10 on hand");

const body = { id: crypto.randomUUID(), registerId: regs[0].id, items: [{ variantId, quantity: 3 }], payments: [{ method: "cash", amount: 500 }] };
const sale = await call("POST", "/sales", body);
must(sale.status === 201, "checkout 201 " + (sale.status === 201 ? "" : JSON.stringify(sale.json)));
must(Number(sale.json.grandTotal) === 300, "server-calculated grand total is 300.00");
const replay = await call("POST", "/sales", body);
must(replay.status === 200 && replay.headers.get("idempotent-replay") === "true" && replay.json.saleNumber === sale.json.saleNumber, "duplicate request replays same invoice " + sale.json.saleNumber);
const after = await call("GET", `/products/lookup/${barcode}`);
must(Number(after.json.stockLevel.onHand) === 7, "inventory reduced 10 -> 7 exactly once");

const out = await call("POST", "/auth/logout");
must(out.status === 200 || out.status === 204, "logout");
const me = await call("GET", "/auth/me");
must(me.status === 401, "session invalid after logout");
console.log("CHECKOUT VERIFIED invoice=" + sale.json.saleNumber);
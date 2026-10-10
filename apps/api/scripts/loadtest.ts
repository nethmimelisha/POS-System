/**
 * Concurrent-cashier load test against a RUNNING API (real HTTP, real PostgreSQL).
 *   BASE_URL=http://localhost:4190 ADMIN_USER=admin ADMIN_PASSWORD=... npx tsx scripts/loadtest.ts
 * Env: CASHIERS (5), SALES_PER_CASHIER (120), PRODUCTS (40), THINK_MS (0)
 * Exits non-zero if any invariant fails: unique invoices, stock = opening - sold, report = client totals, idempotent replays.
 */
import { randomUUID } from "node:crypto";
import http from "node:http";

const BASE = (process.env.BASE_URL ?? "http://127.0.0.1:4000") + "/api/v1";
const CASHIERS = Number(process.env.CASHIERS ?? 5);
const SALES = Number(process.env.SALES_PER_CASHIER ?? 120);
const PRODUCTS = Number(process.env.PRODUCTS ?? 40);
const THINK_MS = Number(process.env.THINK_MS ?? 0); // pause between sales to model a real cashier
const OPENING = 100_000;
const tag = randomUUID().slice(0, 6).toUpperCase();

// node:http with keep-alive: Node 26's built-in fetch stalls 20-60 s on reused sockets on this Windows host (reproducible against a bare http server), which would pollute the latency figures.
const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
const baseUrl = new URL(BASE);

class Session {
  cookie = "";
  req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const t0 = performance.now();
    return new Promise<{ status: number; json: any; ms: number; replay: boolean }>((resolve, reject) => {
      const req = http.request(
        {
          agent,
          method,
          hostname: baseUrl.hostname,
          port: baseUrl.port,
          path: baseUrl.pathname + path,
          headers: { "content-type": "application/json", ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}), ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const set = res.headers["set-cookie"]?.[0];
            if (set) this.cookie = set.split(";")[0];
            let json: any = null;
            try {
              json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
              /* non-JSON */
            }
            resolve({ status: res.statusCode ?? 0, json, ms: performance.now() - t0, replay: res.headers["idempotent-replay"] === "true" });
          });
        },
      );
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
}
const lat: Record<string, number[]> = {};
const rec = (k: string, ms: number) => (lat[k] ??= []).push(ms);
const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] ?? 0;
const fails: string[] = [];
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
  if (!ok) fails.push(msg);
};

interface Sold {
  saleNumber: string;
  grandTotal: number;
  lines: { variantId: string; qty: number }[];
}

async function main() {
  const admin = new Session();
  const login = await admin.req("POST", "/auth/login", { username: process.env.ADMIN_USER ?? "admin", password: process.env.ADMIN_PASSWORD });
  if (login.status !== 200) throw new Error(`admin login failed: ${login.status}`);
  const regs = (await admin.req("GET", "/registers")).json as { id: number }[];

  // Catalog under test
  const variants: { id: string; sku: string; barcode: string; price: number; name: string }[] = [];
  for (let i = 0; i < PRODUCTS; i++) {
    const price = 50 + ((i * 37) % 950);
    const barcode = `88${tag.replace(/\D/g, "0")}${String(i).padStart(5, "0")}`;
    const r = await admin.req("POST", "/products", {
      name: `LT ${tag} Item ${i}`,
      unit: "pcs",
      trackStock: true,
      variants: [{ sku: `LT-${tag}-${i}`, barcodes: [barcode], costPrice: price / 2, sellPrice: price, reorderLevel: 5, openingStock: OPENING }],
    });
    if (r.status !== 201) throw new Error(`product create failed ${r.status} ${JSON.stringify(r.json)}`);
    variants.push({ id: r.json.variants[0].id, sku: `LT-${tag}-${i}`, barcode, price, name: `LT ${tag} Item ${i}` });
  }

  const sessions: Session[] = [];
  for (let c = 0; c < CASHIERS; c++) {
    const username = `lt${tag.toLowerCase()}c${c}`;
    const password = `LoadTest-${tag}-${c}!x`;
    const u = await admin.req("POST", "/users", { username, fullName: `Load ${c}`, password, role: "CASHIER" });
    if (u.status !== 201) throw new Error(`user create failed ${u.status} ${JSON.stringify(u.json)}`);
    const s = new Session();
    if ((await s.req("POST", "/auth/login", { username, password })).status !== 200) throw new Error("cashier login failed");
    sessions.push(s);
  }

  const sold: Sold[] = [];
  const errors: string[] = [];
  let replays = 0;
  let replayMismatch = 0;
  const started = performance.now();

  async function cashier(idx: number) {
    const s = sessions[idx];
    for (let n = 0; n < SALES; n++) {
      if (THINK_MS) await new Promise((r) => setTimeout(r, THINK_MS * (0.5 + Math.random())));
      // Realistic search: partial name, SKU, or barcode scan
      const pick = variants[Math.floor(Math.random() * variants.length)];
      const term = [pick.name.slice(0, 12 + (n % 4)), pick.sku, undefined][n % 3];
      if (term) {
        const r = await s.req("GET", `/products?search=${encodeURIComponent(term)}&pageSize=10`);
        rec("search", r.ms);
        if (r.status !== 200) errors.push(`search ${r.status}`);
      }
      const nLines = 1 + Math.floor(Math.random() * 3);
      const chosen = new Map<string, { v: (typeof variants)[number]; qty: number }>();
      for (let l = 0; l < nLines; l++) {
        const v = variants[Math.floor(Math.random() * variants.length)];
        const code = await s.req("GET", `/products/lookup/${v.barcode}`);
        rec("lookup", code.ms);
        if (code.status !== 200) {
          errors.push(`lookup ${code.status}`);
          continue;
        }
        chosen.set(v.id, { v, qty: (chosen.get(v.id)?.qty ?? 0) + 1 + Math.floor(Math.random() * 2) });
      }
      if (!chosen.size) continue;
      const items = [...chosen.values()].map((c) => ({ variantId: c.v.id, quantity: c.qty }));
      const total = [...chosen.values()].reduce((a, c) => a + c.v.price * c.qty, 0);
      const body = { id: randomUUID(), registerId: regs[idx % regs.length].id, items, payments: [{ method: "cash", amount: Math.ceil(total / 100) * 100 }] };
      const r = await s.req("POST", "/sales", body);
      rec("sale", r.ms);
      if (r.status !== 201) {
        errors.push(`sale ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
        continue;
      }
      sold.push({ saleNumber: r.json.saleNumber, grandTotal: Number(r.json.grandTotal), lines: [...chosen.values()].map((c) => ({ variantId: c.v.id, qty: c.qty })) });
      // ~10% simulate a dropped connection: the client retries the same id and must get the same invoice back
      if (n % 10 === 0) {
        const again = await s.req("POST", "/sales", body);
        rec("sale-replay", again.ms);
        replays++;
        if (!(again.status === 200 && again.replay && again.json.saleNumber === r.json.saleNumber)) replayMismatch++;
      }
    }
  }
  await Promise.all(sessions.map((_, i) => cashier(i)));
  const wall = (performance.now() - started) / 1000;

  console.log(`\n== ${CASHIERS} concurrent cashiers, ${sold.length} sales in ${wall.toFixed(1)}s (${(sold.length / wall).toFixed(1)} sales/s) ==`);
  for (const [k, v] of Object.entries(lat)) console.log(`${k.padEnd(12)} n=${String(v.length).padEnd(5)} p50=${pct(v, 50).toFixed(0)}ms p95=${pct(v, 95).toFixed(0)}ms p99=${pct(v, 99).toFixed(0)}ms max=${Math.max(...v).toFixed(0)}ms`);
  console.log("");

  check(errors.length === 0, `no request errors (${errors.length}${errors.length ? ": " + [...new Set(errors)].slice(0, 5).join("; ") : ""})`);
  check(sold.length === CASHIERS * SALES, `all ${CASHIERS * SALES} sales completed (${sold.length})`);
  check(replays > 0 && replayMismatch === 0, `${replays} duplicate submissions all replayed the original invoice (${replayMismatch} mismatches)`);

  // Invoice numbering: unique, and no gaps within this run's own span
  const nums = sold.map((s) => Number(s.saleNumber.replace(/\D/g, ""))).sort((a, b) => a - b);
  check(new Set(nums).size === nums.length, "invoice numbers are unique");
  const gaps = nums.length ? nums[nums.length - 1] - nums[0] + 1 - nums.length : 0;
  check(gaps === 0, `invoice numbers are contiguous (${gaps} gaps)`);

  // Stock: opening - sold, exactly. No duplicate rows created by replays.
  const soldQty = new Map<string, number>();
  for (const s of sold) for (const l of s.lines) soldQty.set(l.variantId, (soldQty.get(l.variantId) ?? 0) + l.qty);
  let stockBad = 0;
  for (const v of variants) {
    const r = await admin.req("GET", `/products/lookup/${v.barcode}`);
    const onHand = Number(r.json.stockLevel.onHand);
    if (onHand !== OPENING - (soldQty.get(v.id) ?? 0)) stockBad++;
  }
  check(stockBad === 0, `stock on hand equals opening minus units sold for all ${variants.length} products (${stockBad} mismatches)`);

  // Reports: store-wide totals must include at least our sales; our sales are the only ones for LT products
  const clientTotal = sold.reduce((a, s) => a + Math.round(s.grandTotal * 100), 0);
  const prod = await admin.req("GET", `/reports/products?pageSize=200&search=${encodeURIComponent("LT " + tag)}`);
  const rows: any[] = prod.json?.items ?? prod.json?.rows ?? [];
  const ours = rows.filter((r) => String(r.sku ?? r.name ?? "").includes(tag));
  const reportUnits = ours.reduce((a, r) => a + Number(r.quantity ?? r.units ?? r.quantitySold ?? 0), 0);
  const clientUnits = [...soldQty.values()].reduce((a, b) => a + b, 0);
  check(ours.length > 0 && reportUnits === clientUnits, `product report units (${reportUnits}) equal client units sold (${clientUnits})`);
  const reportRevenue = ours.reduce((a, r) => a + Math.round(Number(r.revenue ?? r.netSales ?? r.total ?? r.lineTotal ?? 0) * 100), 0);
  check(reportRevenue === clientTotal, `product report revenue (${(reportRevenue / 100).toFixed(2)}) equals sum of invoice totals (${(clientTotal / 100).toFixed(2)})`);

  const pay = await admin.req("GET", "/reports/payments");
  const cash = (pay.json?.methods ?? []).find((m: any) => m.method === "cash");
  check(!!cash && Number(cash.collected) * 100 >= clientTotal, `cash-collected report includes this run (cash collected ${cash?.collected})`);

  if (fails.length) {
    console.error(`\n${fails.length} invariant(s) failed`);
    process.exit(1);
  }
  console.log("\nAll invariants held.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

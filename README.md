# Retail POS

Single-store, cloud-hosted retail POS for Sri Lanka (LKR, configurable VAT). Docs: [requirements](docs/REQUIREMENTS.md), [tasks](docs/TASKS.md).

## Stack
Express + TypeScript, Prisma, PostgreSQL, session-cookie auth with RBAC (ADMIN / MANAGER / CASHIER). Web app: React + Vite + TypeScript + Tailwind (`apps/web`).

## API quick start (`apps/api`)
```powershell
cd apps\api
copy .env.example .env      # set DATABASE_URL and SEED_ADMIN_PASSWORD
npm install
npx prisma migrate deploy   # apply migrations
npm run seed                # settings, payment methods, VAT rates, registers, admin user
npm run dev
```
`npm test` starts a throw-away embedded PostgreSQL, so no database setup is needed. `npm run typecheck` runs the TypeScript check.

## Endpoints (`/api/v1`, all but login require a session)
| Area | Routes |
|---|---|
| Auth | `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/change-password` |
| Users (admin) | `GET/POST /users`, `PATCH /users/:id` |
| Settings | `GET /settings`, `PUT /settings` (admin) |
| Catalog | `/tax-rates`, `/categories`, `/brands` (read: all, write: manager+) |
| Products | `GET /products?search=&categoryId=&page=`, `GET /products/lookup/:barcodeOrSku`, `GET /products/:id`, `POST /products`, `PATCH /products/:id`, `POST /products/:id/variants`, `PATCH /products/variants/:variantId` |
| Inventory | `GET /inventory/levels?lowOnly=true`, `POST /inventory/adjustments`, `GET /inventory/movements` |
| POS reference | `GET /registers`, `GET /payment-methods` |
| Sales | `POST /sales/quote`, `POST /sales`, `GET /sales`, `GET /sales/:id`, `GET /sales/:id/receipt` |

## Sales & checkout

### Rules
- **Server-side pricing.** The client sends only item ids, quantities, discounts and payments. Unit prices, tax and totals come from the catalog; sending a price or total is rejected with `400`.
- **Discounts.** A discount is `{ "type": "PERCENT" | "AMOUNT", "value": n }`, per line (`items[].discount`) and/or for the whole cart (`discount`). Line discounts apply first, then the cart discount is spread across lines to the exact cent. Cashiers are capped at `MAX_CASHIER_DISCOUNT_PCT` (default 10%) of the pre-discount subtotal; larger discounts need a manager or admin (`403` otherwise).
- **VAT is off by default** (`taxEnabled=false`), so every sale has `taxTotal = 0`. When an admin enables it (`PUT /settings`), only items whose tax rate is `STANDARD` are taxed; zero-rated and exempt items never are. With `pricesIncludeTax=true` the tax is extracted from the price (grand total unchanged); with `false` it is added on top.
- **Payments.** Methods are `cash`, `card`, `online` (see `GET /payment-methods`). `card` and `online` require a `reference` (approval or transaction id). Card/online amounts may not exceed the total; only cash can be over-tendered, and the difference is returned as `changeGiven`. If the payments do not cover the total the request fails with `402` and nothing is saved. `amountPaid` is the total tendered (including change); each payment row stores the amount tendered with that method.
- **Stock.** Each tracked item is deducted through the stock ledger (`SALE` movements) in the same database transaction as the sale. If any line lacks stock (`409 Insufficient stock for <SKU>`), or any later step fails, the whole sale, ledger entries and invoice number roll back. Stock is never driven negative unless `allowNegativeStock` is enabled.
- **Invoice numbers** (`INV-000001`, ...) come from a counter updated inside the sale transaction, so numbers are unique and gapless: a failed sale does not consume one.
- **Idempotency.** The client generates the sale `id` (a UUID) and reuses it when retrying. A repeat of an identical request returns the original sale with `200` and `Idempotent-Replay: true`, without selling or auditing again, even when duplicates arrive simultaneously. Reusing an id with a different payload, or from a different cashier, returns `409`. The first success returns `201` with `Idempotent-Replay: false`.
- **Tracking.** Every sale records the `cashierId`, the `registerId` (required, must be active), an optional `customerId`, and a `sale.create` audit-log entry.
- **Visibility.** Cashiers can only list and read their own sales (others return `404`); managers and admins see all.

### Create a sale
`POST /api/v1/sales`
```json
{
  "id": "7b0c3f0e-5c1a-4c1e-9d55-2f0a1d9b6a11",
  "registerId": 1,
  "items": [
    { "variantId": "dd9876f0-0b58-42cd-b50a-39860e4fad8e", "quantity": 2,
      "discount": { "type": "PERCENT", "value": 5 } }
  ],
  "discount": { "type": "AMOUNT", "value": 10 },
  "payments": [
    { "method": "card", "amount": 500, "reference": "AUTH-4821" },
    { "method": "cash", "amount": 400 }
  ],
  "notes": "optional"
}
```
`201 Created` (trimmed). 2 x Rs. 450 = 900, less 5% on the line (45) and Rs. 10 off the cart = Rs. 845; Rs. 900 tendered, Rs. 55 change:
```json
{
  "id": "7b0c3f0e-5c1a-4c1e-9d55-2f0a1d9b6a11",
  "saleNumber": "INV-000024",
  "status": "COMPLETED",
  "registerId": 1,
  "cashierId": "3e48cd53-b17d-4e50-936a-5905ab5d2f96",
  "subtotal": "900",
  "discountTotal": "55",
  "taxTotal": "0",
  "grandTotal": "845",
  "amountPaid": "900",
  "changeGiven": "55",
  "items": [
    { "description": "Basmati Rice 1kg", "sku": "DOC-RICE", "quantity": "2",
      "unitPrice": "450", "discount": "55", "taxAmount": "0", "lineTotal": "845" }
  ],
  "payments": [
    { "amount": "500", "reference": "AUTH-4821", "method": { "code": "card", "name": "Card" } },
    { "amount": "400", "reference": null, "method": { "code": "cash", "name": "Cash" } }
  ],
  "cashier": { "username": "admin", "fullName": "Administrator" },
  "register": { "id": 1, "name": "Register 1" }
}
```
Money values are decimal strings. `subtotal` is the pre-discount total (tax-inclusive when `pricesIncludeTax` is true); `discountTotal` is line discounts plus the cart discount.

Re-sending the identical request returns `200` with the same body and `Idempotent-Replay: true`.

### Get the receipt
`GET /api/v1/sales/7b0c3f0e-5c1a-4c1e-9d55-2f0a1d9b6a11/receipt` returns display-ready data (amounts formatted as `Rs. 1,500.00`) for the browser/thermal print view:
```json
{
  "invoiceNumber": "INV-000024",
  "issuedAt": "2026-10-10T04:51:11.812Z",
  "currency": { "code": "LKR", "symbol": "Rs." },
  "business": { "name": "My Store", "address": null, "phone": null, "vatNumber": null },
  "cashier": "Administrator",
  "register": "Register 1",
  "items": [
    { "description": "Basmati Rice 1kg", "sku": "DOC-RICE", "quantity": 2,
      "unitPrice": "Rs. 450.00", "discount": "Rs. 55.00", "lineTotal": "Rs. 845.00" }
  ],
  "totals": { "subtotal": "Rs. 900.00", "discount": "Rs. 55.00", "tax": null,
              "grandTotal": "Rs. 845.00", "paid": "Rs. 900.00", "change": "Rs. 55.00" },
  "tax": null,
  "payments": [
    { "method": "Card", "amount": "Rs. 500.00", "reference": "AUTH-4821" },
    { "method": "Cash", "amount": "Rs. 400.00", "reference": null }
  ]
}
```
When a sale carries VAT, `totals.tax` is set, `business.vatNumber` is printed, and `tax` holds `{ "note": "Prices include VAT", "breakdown": [{ "ratePct": 18, "taxableAmount": "Rs. 100.00", "taxAmount": "Rs. 18.00" }] }`.

### Quote a cart (no side effects)
`POST /api/v1/sales/quote` prices a cart exactly as checkout would (same code path, same discount authorization) without creating a sale or touching stock. The web app calls it on every cart change so it never calculates money itself. Body: `{ "items": [{ "variantId": "<uuid>", "quantity": 2, "discount": { "type": "PERCENT", "value": 10 } }], "discount": { "type": "AMOUNT", "value": 50 } }`. Response (money as 2-decimal strings):
```json
{
  "lines": [{ "variantId": "<uuid>", "description": "Basmati Rice 1kg", "sku": "RICE-1KG", "quantity": 2, "unitPrice": "450.00", "lineTotal": "900.00", "onHand": 50, "insufficientStock": false }],
  "subtotal": "900.00", "discountTotal": "0.00", "taxTotal": "0.00", "grandTotal": "900.00", "canCheckout": true
}
```
`canCheckout` is `false` when any line exceeds available stock. Errors match `POST /sales` (e.g. 403 for a cashier discount above the limit). The exact field set is defined in `apps/api/src/routes/sales.ts` and covered by `tests/quote.test.ts`.

### List sales
`GET /api/v1/sales?from=2026-10-10&to=2026-10-11&status=COMPLETED&registerId=1&cashierId=<uuid>&page=1&pageSize=25` returns `{ total, page, pageSize, items: [{ id, saleNumber, status, grandTotal, discountTotal, taxTotal, createdAt, registerId, cashier, _count: { items } }] }`.

### Errors
| Status | Example body | Cause |
|---|---|---|
| 400 | `{ "error": "A reference is required for Card payments" }` | Validation: unknown item/register/method, missing reference, card overpayment, client-sent prices (`Validation failed`) |
| 401 | `{ "error": "Not authenticated" }` | No or expired session |
| 402 | `{ "error": "Insufficient payment: Rs. 745.00 remaining" }` | Payments do not cover the total |
| 403 | `{ "error": "Discounts above 10% need manager approval" }` | Cashier discount limit |
| 404 | `{ "error": "Sale not found" }` | Unknown sale, or another cashier's sale |
| 409 | `{ "error": "Insufficient stock for DOC-RICE" }` | Not enough stock, item inactive, or sale id reused with a different request |

## Design notes
- Stock is an append-only ledger (`StockMovement`) plus a locked `StockLevel` balance, updated in one transaction. Concurrent sales lock stock rows in a fixed order, so they cannot oversell or deadlock.
- Tax is disabled by default until VAT registration is confirmed. Confirm the seeded 18% rate against current IRD rules before enabling.
- Money is `Decimal(12,2)`; sale lines snapshot description, SKU, price, cost and tax. Pricing is computed in integer cents.

## Web app (`apps/web`)
React 19 + Vite + TypeScript + Tailwind 4, TanStack Query, React Router. Light theme with navy accents; desktop and tablet layouts.

```powershell
# terminal 1: API + embedded PostgreSQL + demo data (no database install needed)
cd apps\api; npm install; npm run local          # http://localhost:4000
# terminal 2: web app
cd apps\web; npm install; npm run dev            # http://localhost:5173
```
Demo logins: `admin` / `Admin12345!`, `manager` / `Demo12345!`, `cashier` / `Demo12345!`. Demo barcodes: `4791000000011` (rice), `4791000000066` (water); the exercise book has low stock.

| Command (in `apps/web`) | Purpose |
|---|---|
| `npm run dev` | Dev server. `/api` is proxied to `VITE_API_TARGET` (default `http://localhost:4000`), so the session cookie is first-party and needs no CORS. |
| `npm run typecheck` / `npm run build` | TypeScript check / production build to `dist/` |
| `npm test` | Unit tests (cart, scan parsing, idempotent attempts, formatting, role navigation) |
| `npm run e2e` | Playwright (Microsoft Edge) against the **real** API and a throw-away embedded PostgreSQL; nothing is mocked. Ports 4100, 5273 and 54331 must be free. `E2E_BROWSER=chrome` uses Chrome. |

### Screens and roles
| Screen | Cashier | Manager | Admin |
|---|---|---|---|
| Checkout (scan/search, cart, discounts, cash/card/online/split payment, receipt, print) | yes | yes | yes |
| Dashboard (today's sales; low stock for manager+) | yes | yes | yes |
| Sales history + receipt reprint | yes | yes | yes |
| Products, Inventory (adjust, history, low stock) | - | yes | yes |
| Settings: change password | yes | yes | yes |
| Settings: business (edit) and users | - | - | yes |

### How checkout behaves
- **Scanning:** USB scanners in keyboard mode type into the always-focused scan box and press Enter. Enter tries an exact barcode/SKU match, otherwise shows name/SKU search results. `3*<barcode>` adds quantity 3.
- **Server is the authority:** prices, discounts, tax, totals, stock flags and discount permissions come from `POST /sales/quote` and `POST /sales`. A cashier discount over the limit shows the server's message and disables Charge.
- **Idempotent retries:** a sale id is created when payment starts and kept with the cart. An unchanged retry reuses it and the server replays the original sale instead of duplicating it. After a network failure the outcome is unknown, so the form locks to the identical request; the cashier can retry or use "Check status" (`GET /sales/:id`). Submit is guarded against double clicks.
- **Failures never clear the cart.** Only a successful sale does. On session expiry the user is sent to login and the cart (kept in `sessionStorage`, no credentials) survives sign-in.
- **Security:** the session is an HttpOnly cookie; no token is stored in web storage.
- **Printing:** the receipt renders into `#print-root` and `window.print()` uses an `@page { size: 80mm auto }` layout. In the print dialog choose the thermal printer, paper "80mm", margins "None", headers/footers off.

### Deployment note
Serve the web build and the API from the same site (static files plus a reverse proxy for `/api` to Express), or set `CORS_ORIGIN` to the web origin on the same registrable domain so the `SameSite=Lax` cookie is sent. Use HTTPS in production (the cookie is `Secure` when `NODE_ENV=production`).

### Screenshots (`docs/screenshots`, written by the e2e run)
[Login](docs/screenshots/01-login.png) · [POS empty](docs/screenshots/02-pos-empty.png) · [Discount rejected](docs/screenshots/03-pos-discount-rejected.png) · [Cart](docs/screenshots/04-pos-cart.png) · [Split payment](docs/screenshots/05-payment-split.png) · [Receipt](docs/screenshots/06-receipt.png) · [Cashier dashboard](docs/screenshots/07-dashboard-cashier.png) · [Insufficient stock](docs/screenshots/08-insufficient-stock.png) · [Network failure](docs/screenshots/09-network-failure.png) · [Tablet](docs/screenshots/10-pos-tablet.png) · [Manager dashboard](docs/screenshots/11-dashboard-manager.png) · [Products](docs/screenshots/12-products.png) · [Inventory](docs/screenshots/13-inventory-low-stock.png) · [Settings](docs/screenshots/14-settings.png) · [Sales](docs/screenshots/15-sales.png) · [80 mm receipt PDF](docs/screenshots/receipt-80mm.pdf)

## Sprint 4: returns, shifts, reports, customers

Migration: `apps/api/prisma/migrations/20261011000000_returns_shifts_reports` (additive; apply with `npx prisma migrate deploy`). Nothing from Sprints 1-3 changed shape; sales gain optional `customerId` and `shiftId`.

### Endpoints
| Area | Routes (role) |
|---|---|
| Returns | `GET /returns/sale/:saleId/returnable`, `POST /returns/quote`, `POST /returns`, `GET /returns?pendingRefunds=true`, `GET /returns/:id`, `GET /returns/:id/receipt`, `POST /returns/:id/refunds/:refundId/confirm`, `POST /returns/:id/refunds/:refundId/fail`, `POST /returns/:id/refunds` (reissue after a failed external refund). **Manager/admin only.** |
| Shifts | `GET /shifts/mine`, `GET /shifts/current?registerId=`, `GET /shifts`, `GET /shifts/:id`, `POST /shifts/open`, `POST /shifts/:id/cash-movements`, `POST /shifts/:id/close` (cashiers: own shifts; managers: all), `POST /shifts/:id/approve` (manager/admin, must not be the shift's cashier) |
| Customers | `GET /customers?search=`, `POST /customers`, `GET /customers/:id`, `PATCH /customers/:id` (all roles); `GET /customers/:id/history` (manager+) |
| Reports (manager+) | `GET /reports/sales?groupBy=day\|week\|month`, `/payments`, `/cashiers`, `/products`, `/low-stock`, `/tax`, `/shifts`; filters `from`, `to` (`YYYY-MM-DD`), `page`, `pageSize` |
| Sales | `POST /sales` accepts optional `customerId`; walk-in sales omit it. `GET /sales?customerId=&search=` |
| Variants | `PATCH /products/variants/:id` edits `sku`, `name`, `costPrice`, `sellPrice`, `reorderLevel`, `isActive`, `barcodes` (duplicate SKU/barcode: 409, audited as `variant.update`). Old sale items keep their own snapshot of name, SKU and price. |
| Settings | new `requireShift` (default `false`) and `timezone` (default `Asia/Colombo`) |

### Rules
- **Returns:** quantity is checked against sold minus already returned inside one transaction with row locks, so concurrent requests cannot refund an item twice. The request `id` is the idempotency key: replaying it returns the original return. Stock is restored only for lines sent with `resellable: true` on stock-tracked items. Refunds per method cannot exceed what was paid by that method and not yet refunded. Discounts are apportioned, so a partial return refunds what was actually paid.
- **Cash refunds** complete immediately and reduce the drawer. **Card/online refunds are created `PENDING`** and need `confirm` (provider reference) or `fail` (reason). The system never marks them complete by itself; there is no payment-provider integration.
- **Shifts:** one open shift per register (database-enforced, so simultaneous opens give one 201 and one 409). Sales and cash refunds attach to the register's open shift. Expected cash = opening + cash received - change given + cash in - cash out - cash refunds; card and online are excluded. A non-zero variance needs closing notes and is `PENDING_APPROVAL` until a different manager approves it. With `requireShift=true`, sales on a register without an open shift are rejected (off by default so existing flows keep working).
- **Reports:** money is summed in PostgreSQL `numeric` and returned as 2 dp strings. Days/weeks/months are cut in the store `timezone`. *Sales revenue* (what was sold, net of refunds) is reported separately from *cash collected* (money that entered/left the drawer and other tenders), and pending refunds are listed separately. Returns are bucketed by return date, not original sale date.

### Examples
```http
POST /api/v1/shifts/open
{ "registerId": 1, "openingCash": 5000 }
-> 201 { "id": 7, "status": "OPEN", "openingCash": "5000.00", "summary": { "expectedCash": "5000.00", ... } }

POST /api/v1/shifts/7/cash-movements
{ "type": "CASH_OUT", "amount": 300, "reason": "Supplier payment" }

POST /api/v1/shifts/7/close
{ "countedCash": 6150, "notes": "Counted twice" }
-> 200 { "status": "CLOSED", "expectedCash": "6200.00", "countedCash": "6150.00", "variance": "-50.00", "discrepancy": "PENDING_APPROVAL" }

POST /api/v1/shifts/7/approve      (a different manager)
{ "note": "Recount confirmed" }

POST /api/v1/returns
{ "id": "6b1d...-uuid", "saleId": "<sale id>", "registerId": 1, "reason": "CHANGED_MIND",
  "items": [{ "saleItemId": "12", "quantity": 1, "resellable": true }],
  "refunds": [{ "method": "cash", "amount": 500 }] }
-> 201 { "returnNumber": "RET-000001", "refundTotal": "500.00",
         "refunds": [{ "method": "cash", "amount": "500.00", "status": "COMPLETED" }] }
   409 { "error": "Cannot return 1 of S4 Widget: only 0 remaining" }   (over-return / duplicate refund)
   409 { "error": "Card refunds cannot exceed Rs. 0.00 (the amount originally paid that way and not yet refunded)" }

POST /api/v1/returns/<id>/refunds/<refundId>/confirm
{ "providerReference": "PROV-OK-1" }

GET /api/v1/reports/payments?from=2026-10-01&to=2026-10-31
-> { "timezone": "Asia/Colombo", "revenue": { "salesTotal": "1500.00", "refunds": "500.00", "netSales": "1000.00" },
     "note": "Revenue is what was sold; cash collected is money tendered...",
     "methods": [{ "method": "cash", "isCash": true, "collected": "1000.00", "refundsCompleted": "500.00", "refundsPending": "0.00", "netCollected": "500.00" }] }
```
Roles: cashiers receive 403 on every `/returns`, `/reports` and customer-history route.

### Screens
Shifts & cash drawer (all roles), Returns & refunds and Reports (manager+), Customers (all; purchase history manager+), per-variant editing inside Products, an optional customer picker and shift banner at Checkout, and `requireShift`/timezone in Settings (admin).
Screenshots: [shift open](docs/screenshots/16-shift-open.png) · [return form](docs/screenshots/17-return-form.png) · [refund receipt](docs/screenshots/17b-refund-receipt.png) · [return history](docs/screenshots/18-return-history.png) · [shift closed](docs/screenshots/19-shift-closed.png) · [sales report](docs/screenshots/20-reports-sales.png) · [shift report](docs/screenshots/21-reports-shifts.png) · [customers](docs/screenshots/22-customers.png) · [variants](docs/screenshots/23-variants.png)

### Sprint 4 limitations
- Returns are manager/admin only; cashiers cannot start a return.
- No payment-provider integration: card/online refunds are recorded and confirmed manually. A failed external refund can be reissued only by non-cash method.
- `requireShift` is opt-in. Report CSV export, exchanges, voids, held sales and loyalty are not built.
- Variant stock changes go through Inventory adjustments, not the variant form. Variants are deactivated, never deleted.
- Not deployed; run `prisma migrate deploy` against a backup first in any real environment.

### Not built yet / known limitations
- No direct ESC/POS printing (cash-drawer kick, auto-cut) yet; the hardware layer is ready and browser printing is the fallback.
- No offline mode: checkout needs the server.
- Voids apply to held sales only; completed sales are refunded via Returns (see Sprint 5 below).
- The dashboard aggregates today's sales in the browser (up to 2,000 sales); add a server-side summary endpoint at higher volume.
- No category or tax-rate management screens.
- Reprinted receipts are not marked as duplicates.
- The seeded 18% VAT rate must be verified against current IRD rules before VAT is enabled (VAT is off by default).
- Tablet checks used a 1024x768 browser viewport, not a physical device, scanner or printer.
- The e2e run sets `NODE_ENV=test` to relax the login rate limit.

## Sprint 5: production readiness, exports, voids, exchanges

Migration: `apps/api/prisma/migrations/20261101000000_sprint5_void_exchange` (additive; `prisma migrate deploy`). Sprint 1-4 migrations are untouched.
Operational docs: [DEPLOYMENT.md](docs/DEPLOYMENT.md) · [BACKUP-RECOVERY.md](docs/BACKUP-RECOVERY.md). **Nothing has been deployed.**

### New endpoints
| Area | Routes (role) |
|---|---|
| Health | `GET /health` (liveness), `GET /ready` (database reachable; 503 otherwise). Public, return only `{status}`. |
| Hold / void | `POST /sales/hold` (any role; parks a cart as `HLD-nnnnnn`, no stock or money moves), `POST /sales/:id/void` (manager/admin; body `{reason}` 3-300 chars) |
| Exchanges | `POST /exchanges/quote`, `POST /exchanges`, `GET /exchanges`, `GET /exchanges/:id`, `GET /exchanges/:id/receipt` (manager/admin) |
| Reports | new `GET /reports/refunds` and `/reports/inventory` (manager+), same filters as before |
| Exports | `GET /exports/{sales,refunds,inventory,shifts,tax,products}.{csv,pdf}?from=&to=` (manager/admin; audited as `export.download`) |

### Voids
- **Held (unpaid) sales** can be voided by a manager/admin with a mandatory reason; the void is audited (`sale.void`) and stock was never reserved, so nothing is adjusted. Repeating a void returns `409 ALREADY_VOIDED`.
- **Completed sales cannot be voided** (`409 USE_RETURNS`). Refund them through Returns so every financial record is preserved.

### Exchanges
Return items from an original invoice (same quantity checks and row locks as returns; restock only if `resellable`) and take replacement items in one transaction. The price difference is settled by **payment** (if the customer owes) or **refund** (if the store owes); card/online refunds stay pending until confirmed. Internally the returned value is applied through a system tender `exchange_credit`, which is excluded from payment and cash-drawer reports. The request `id` is the idempotency key (replay returns the original with `Idempotent-Replay: true`); concurrent exchanges of the same item let exactly one succeed; underpayment returns 402; any failure rolls back stock and money.
```http
POST /api/v1/exchanges
{ "id": "0c9e...-uuid", "saleId": "<sale id>", "registerId": 1, "reason": "WRONG_ITEM",
  "returnItems": [{ "saleItemId": "12", "quantity": 1, "resellable": true }],
  "newItems": [{ "variantId": "<variant id>", "quantity": 1 }],
  "payments": [{ "method": "card", "amount": 300, "reference": "AUTH-1" }], "refunds": [] }
-> 201 { "exchangeNumber": "EXC-000001", "returnedValue": "500.00", "issuedValue": "800.00", "difference": "300.00", ... }
   402 { "error": "..." }  underpaid     409 { "error": "..." }  over-return / already returned
```

### Exports
CSV (UTF-8 BOM, CRLF, RFC 4180 quoting) and PDF (A4, server-rendered with pdfkit) are produced from the same report handlers as the on-screen reports, so filters, permissions and decimal maths are identical. Text cells starting with `= + - @` (or tab/CR) are prefixed with `'` to prevent spreadsheet formula injection; numeric columns are only left untouched when they are genuine numbers. Responses are `Content-Disposition: attachment`.
```http
GET /api/v1/exports/refunds.csv?from=2026-10-01&to=2026-10-31
-> 200 text/csv   (cashier: 403)
```

### Security and production configuration
- `NODE_ENV=production` validates the environment at startup and **exits** on: weak/default database password, non-HTTPS or wildcard/localhost `CORS_ORIGIN`, `ENFORCE_HTTPS=false`, and any demo switch (`SEED_DEMO`, `ENABLE_DEMO_USERS`, `DEMO_PASSWORD`, `SEED_ADMIN_PASSWORD`) or known demo credentials in the database. Template: `apps/api/.env.example`, `deploy/.env.production.example`.
- **First administrator:** `npm run provision:admin` (password from `ADMIN_PASSWORD`, a hidden prompt, or `--generate` for a random one printed once; refuses weak passwords; there is no default password).
- HTTPS enforced (426 without `X-Forwarded-Proto: https`), HSTS, `__Host-` session cookie (`Secure`, `HttpOnly`, `SameSite`), strict CORS allow-list, helmet-style headers with CSP `default-src 'none'` on the API, JSON body limit (`JSON_BODY_LIMIT`, default 256kb), rate limits (login 20 per 15 min, sensitive operations 60/min, general 1200/min) and safe error bodies (no stack traces or SQL).
- Structured JSON logging (pino) with redaction of passwords, cookies, tokens, secrets and personal data (phone, email).

### Hardware abstraction (`apps/web/src/hardware`)
`ReceiptPrinter`, `BarcodeScanner` and `CashDrawer` interfaces. Implemented: USB keyboard-wedge scanner detection (fast burst + Enter), **browser 80 mm printing** (default and fallback), an ESC/POS byte encoder (including the drawer-kick command) behind a pluggable raw transport, and an `UnsupportedCashDrawer`. `printWithFallback` always falls back to browser print if a raw printer is missing or fails. No browser can reach every USB or network printer, and no hardware has been selected or purchased; raw transports (WebUSB/Web Serial/local agent) are future work once models are confirmed.

### Backup and recovery
Encrypted (AES-256-GCM) `pg_dump` backups with retention, failure/staleness webhook alerts, a restore command and `restore:verify` (restores into an isolated scratch database and compares counts and sale totals). See [docs/BACKUP-RECOVERY.md](docs/BACKUP-RECOVERY.md) for the disaster-recovery procedure.

### Docker and deployment prep
`deploy/` contains `Dockerfile.api`, `Dockerfile.web` (nginx), `docker-compose.prod.yml` (db, migrate, api, backup, web, edge), `Caddyfile`/nginx edge config and an environment template. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

### Screens
Exchanges (manager+), Void action and status filter on Sales, CSV/PDF export bar on Reports.
Screenshots: [exchange](docs/screenshots/25-exchange.png) · [exchange receipt](docs/screenshots/26-exchange-receipt.png) · [void](docs/screenshots/27-void.png) · [exports](docs/screenshots/28-exports.png)

### Tests
`npm test` in `apps/api` (sprint5, production config/hardening, backup restore, build + production startup suites), `npm test` and `npm run e2e` in `apps/web` (e2e uses the real API and PostgreSQL).

### Sprint 5 limitations
- **Docker images and compose files were written but not built or run** (Docker is not installed on the development machine). Build and smoke-test them before relying on them.
- No direct ESC/POS/USB printing or cash-drawer kick yet; browser printing remains the working path.
- Held sales can be created and voided but not resumed into a checkout.
- Card/online refunds and exchange refunds are confirmed manually; there is no payment-provider integration.
- Restore was verified into an isolated database with PostgreSQL 18 client tools; a restore on the production host has not been exercised.
- Recovery point objective equals the backup interval (daily by default).
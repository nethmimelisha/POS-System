# Retail POS – Requirements (Step 1)

**Deployment:** online (cloud-hosted web app, browser-based POS). **Scope:** single business (single-tenant), one or more registers; schema keeps an optional `store` concept out for now.

## Assumptions (change if wrong)
- Stack: PostgreSQL, Node.js + TypeScript API (REST), React web front-end (PWA).
- Currency: single, configurable. Tax: inclusive or exclusive, configurable per tax rate (GST/VAT style).
- Payments in v1: cash, card (recorded manually / external terminal), UPI/wallet (reference number). Gateway integration is later.
- Online-only: no offline mode in v1 (PWA offline queue is a later phase).

## Roles
| Role | Capabilities |
|---|---|
| Owner/Admin | Everything, settings, users, reports |
| Manager | Catalog, inventory, refunds/voids, discounts override, reports, shift close |
| Cashier | Sell, hold/resume carts, take payments, open/close own shift |

## Functional requirements
### 1. Authentication & users
- FR-1.1 Email/username + password login (argon2/bcrypt), JWT access + refresh tokens.
- FR-1.2 Role-based access control; optional quick PIN for cashier re-auth/manager override.
- FR-1.3 Audit log for sensitive actions (void, refund, price change, stock adjustment, login).

### 2. Catalog
- FR-2.1 Products with SKU, name, category, brand, unit, tax rate, cost, price, active flag.
- FR-2.2 Variants (size/colour) each with own SKU, barcode(s), price.
- FR-2.3 Categories (hierarchical). Product images (URL).
- FR-2.4 Barcode lookup < 200 ms; search by name/SKU.
- FR-2.5 CSV import/export of products.

### 3. Inventory
- FR-3.1 Stock tracked per variant via immutable stock-movement ledger (sale, return, purchase receipt, adjustment, damage).
- FR-3.2 Low-stock threshold and alerts.
- FR-3.3 Suppliers and purchase orders with goods receipt (updates stock and cost).
- FR-3.4 Stock take / manual adjustment with reason.
- FR-3.5 Option to block or allow selling at zero stock.

### 4. Sales / checkout
- FR-4.1 Scan/search to add items; edit quantity; line and cart discounts (% or amount) with permission limits.
- FR-4.2 Tax calculation per line; rounding rules stored on the sale.
- FR-4.3 Hold and resume carts.
- FR-4.4 Split payments across multiple methods; change due for cash.
- FR-4.5 Sequential receipt/invoice number; print (thermal 58/80mm, browser print) and email/SMS/WhatsApp later.
- FR-4.6 Price/tax/cost snapshotted on sale lines (history never changes with catalog edits).
- FR-4.7 Idempotent sale submission (client-generated UUID) to prevent duplicates on retry.

### 5. Returns & voids
- FR-5.1 Return against original sale (partial lines), refund to original method or store credit; restock optional.
- FR-5.2 Void of an unfinished/held sale; voiding completed sales only via return (manager approval).

### 6. Customers (optional on a sale)
- FR-6.1 Customer record (name, phone, email, GSTIN/tax id), purchase history.
- FR-6.2 Loyalty points earn/redeem (phase 2), store credit.

### 7. Cash drawer & shifts
- FR-7.1 Register open shift with opening float; close with counted cash; variance computed.
- FR-7.2 Cash in/out movements (paid-outs, drops) with reason.
- FR-7.3 X report (mid-shift) and Z report (close).

### 8. Promotions (phase 2)
- Percentage/amount off, buy X get Y, coupon codes, date ranges.

### 9. Reporting
- Daily sales, sales by product/category/cashier/payment method, tax summary, gross margin, stock valuation, low stock, shift reports. Export CSV/PDF.

### 10. Settings
- Business profile, receipt header/footer, tax rates, payment methods, numbering prefixes, rounding, registers.

## Non-functional requirements
- **Security:** HTTPS only, hashed passwords, RBAC on every endpoint, input validation, rate-limit login, no card data stored (PCI out of scope by using external terminals).
- **Performance:** checkout API p95 < 300 ms; product search < 200 ms for 50k SKUs.
- **Integrity:** money stored as integer minor units (or numeric(12,2)); all sale writes in one DB transaction; ledger tables append-only.
- **Availability:** daily automated backups, point-in-time recovery; target 99.5%.
- **Usability:** keyboard/barcode-scanner-first, touch-friendly, works on tablet and desktop.
- **Observability:** structured logs, error tracking, health endpoint.

## Out of scope for v1
Multi-store/multi-tenant, offline mode, e-commerce sync, payment gateway integration, accounting export, hardware drivers beyond browser print.

## Milestones
1. Foundation (repo, DB, auth) → 2. Catalog & inventory → 3. Checkout & payments → 4. Returns, shifts → 5. Reports → 6. Hardening & deploy.

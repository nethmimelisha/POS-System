export type Role = "ADMIN" | "MANAGER" | "CASHIER";

export interface User {
  id: string;
  username: string;
  fullName: string;
  role: Role;
}

export interface ManagedUser extends User {
  email: string | null;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface Settings {
  name: string;
  address: string | null;
  phone: string | null;
  vatNumber: string | null;
  currencyCode: string;
  currencySymbol: string;
  taxEnabled: boolean;
  pricesIncludeTax: boolean;
  allowNegativeStock: boolean;
  requireShift: boolean;
  timezone: string;
  receiptHeader: string | null;
  receiptFooter: string | null;
}

export interface Register {
  id: number;
  name: string;
}

export interface PaymentMethod {
  id: number;
  code: string;
  name: string;
  isCash: boolean;
}

export interface TaxRate {
  id: number;
  name: string;
  type: "STANDARD" | "ZERO_RATED" | "EXEMPT";
  ratePct: string;
  isActive: boolean;
}

export interface Category {
  id: number;
  name: string;
  parentId: number | null;
}

export interface StockLevel {
  variantId: string;
  onHand: string;
}

export interface Variant {
  id: string;
  productId: string;
  sku: string;
  name: string | null;
  costPrice: string;
  sellPrice: string;
  reorderLevel: string;
  isActive: boolean;
  barcodes: { barcode: string }[];
  stockLevel: StockLevel | null;
}

export interface Product {
  id: string;
  name: string;
  description: string | null;
  unit: string;
  trackStock: boolean;
  isActive: boolean;
  categoryId: number | null;
  taxRateId: number | null;
  category: Category | null;
  taxRate: TaxRate | null;
  variants: Variant[];
}

export interface Paged<T> {
  total: number;
  page: number;
  pageSize: number;
  items: T[];
}

/** Result of GET /products/lookup/:code, a single sellable variant. */
export interface LookupVariant extends Variant {
  product: Product;
}

export type Discount = { type: "PERCENT" | "AMOUNT"; value: number };

export interface QuoteItemInput {
  variantId: string;
  quantity: number;
  discount?: Discount;
}

export interface QuoteLine {
  variantId: string;
  description: string;
  sku: string;
  quantity: number;
  unitPrice: string;
  discount: string;
  taxRatePct: number;
  taxAmount: string;
  lineTotal: string;
  trackStock: boolean;
  onHand: number;
  insufficientStock: boolean;
}

export interface Quote {
  lines: QuoteLine[];
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  grandTotal: string;
  taxEnabled: boolean;
  pricesIncludeTax: boolean;
  canCheckout: boolean;
}

export interface SalePaymentInput {
  method: string;
  amount: number;
  reference?: string;
}

export interface SaleInput {
  id: string;
  registerId: number;
  items: QuoteItemInput[];
  discount?: Discount;
  payments: SalePaymentInput[];
  customerId?: string;
  notes?: string;
}

export interface Sale {
  id: string;
  saleNumber: string;
  status: "HELD" | "COMPLETED" | "VOIDED";
  grandTotal: string;
  amountPaid: string;
  changeGiven: string;
}

export interface SaleSummary {
  id: string;
  saleNumber: string;
  status: Sale["status"];
  grandTotal: string;
  discountTotal: string;
  taxTotal: string;
  createdAt: string;
  registerId: number | null;
  cashier: { id: string; fullName: string };
  _count: { items: number };
}

export interface Receipt {
  invoiceNumber: string;
  status: string;
  issuedAt: string;
  currency: { code: string; symbol: string };
  business: { name: string; address: string | null; phone: string | null; vatNumber: string | null };
  header: string | null;
  footer: string | null;
  cashier: string;
  register: string | null;
  customer: { name: string; phone: string | null } | null;
  items: {
    description: string;
    sku: string;
    quantity: number;
    unitPrice: string;
    discount: string | null;
    lineTotal: string;
  }[];
  totals: {
    subtotal: string;
    discount: string;
    tax: string | null;
    grandTotal: string;
    paid: string;
    change: string;
  };
  tax: { note: string; breakdown: { ratePct: number; taxableAmount: string; taxAmount: string }[] } | null;
  payments: { method: string; amount: string; reference: string | null }[];
}

export interface LowStockRow {
  variantId: string;
  sku: string;
  productName: string;
  variantName: string | null;
  reorderLevel: string;
  onHand: string;
}

export interface StockMovement {
  id: string;
  variantId: string;
  type: string;
  quantity: string;
  reason: string | null;
  createdAt: string;
}

// ---------- Sprint 4 ----------
export interface Customer {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  notes: string | null;
  createdAt: string;
}

export interface CustomerHistory {
  customer: Customer;
  summary: { purchases: number; totalSpent: string; totalRefunded: string; netSpent: string; lastPurchaseAt: string | null };
  total: number;
  page: number;
  pageSize: number;
  sales: {
    id: string;
    saleNumber: string;
    status: string;
    grandTotal: string;
    createdAt: string;
    cashier: { fullName: string };
    _count: { items: number };
    returns: { returnNumber: string; refundTotal: string }[];
  }[];
}

export type ShiftStatus = "OPEN" | "CLOSED";
export type DiscrepancyStatus = "NONE" | "PENDING_APPROVAL" | "APPROVED";

export interface ShiftSummary {
  openingCash: string;
  cashSales: string;
  changeGiven: string;
  netCashSales: string;
  cashIn: string;
  cashOut: string;
  cashRefunds: string;
  expectedCash: string;
  nonCashSales: { method: string; amount: string }[];
  nonCashRefunds: { method: string; amount: string; status: string }[];
  salesCount: number;
  returnsCount: number;
}

export interface CashMovement {
  id: string;
  type: "CASH_IN" | "CASH_OUT";
  amount: string;
  reason: string;
  createdAt: string;
  createdBy: { fullName: string };
}

export interface Shift {
  id: number;
  registerId: number;
  cashierId: string;
  status: ShiftStatus;
  openedAt: string;
  closedAt: string | null;
  openingCash: string;
  expectedCash: string | null;
  countedCash: string | null;
  variance: string | null;
  discrepancy: DiscrepancyStatus;
  closingNotes: string | null;
  approvalNote: string | null;
  register: Register;
  cashier: { id: string; username: string; fullName: string };
  approvedBy: { fullName: string } | null;
  summary: ShiftSummary | null;
  movements?: CashMovement[];
}

export type ReturnReason = "DEFECTIVE" | "DAMAGED" | "WRONG_ITEM" | "CHANGED_MIND" | "OVERCHARGED" | "OTHER";
export type RefundStatus = "COMPLETED" | "PENDING" | "FAILED";

export interface Returnable {
  sale: { id: string; saleNumber: string; status: string; grandTotal: string; createdAt: string; cashier: string; customer: { id: string; name: string } | null };
  items: {
    saleItemId: string;
    description: string;
    sku: string;
    soldQuantity: string;
    returnedQuantity: string;
    remainingQuantity: string;
    unitPrice: string;
    lineTotal: string;
    refundedAmount: string;
    remainingRefundable: string;
  }[];
  fullyReturned: boolean;
  paidByMethod: { method: string; name: string; amount: string }[];
  refundedByMethod: { method: string; amount: string }[];
}

export interface ReturnQuote {
  refundTotal: string;
  taxTotal: string;
  lines: { saleItemId: string; quantity: string; refundAmount: string }[];
}

export interface SaleReturn {
  id: string;
  returnNumber: string;
  reason: ReturnReason;
  notes: string | null;
  refundTotal: string;
  createdAt: string;
  sale: { id: string; saleNumber: string };
  processedBy: { fullName: string };
  items: { description: string; sku: string; quantity: string; refundAmount: string; resellable: boolean; restocked: boolean }[];
  refunds: { id: number; amount: string; status: RefundStatus; reference: string | null; providerReference: string | null; method: PaymentMethod }[];
}

export interface RefundReceipt {
  documentType: "REFUND";
  refundNumber: string;
  originalInvoice: string;
  issuedAt: string;
  business: { name: string; address: string | null; phone: string | null; vatNumber: string | null };
  processedBy: string;
  register: string | null;
  customer: { name: string; phone: string | null } | null;
  reason: string;
  notes: string | null;
  items: { description: string; sku: string; quantity: number; refundAmount: string }[];
  totals: { tax: string | null; refundTotal: string };
  refunds: { method: string; amount: string; status: RefundStatus; statusNote: string; reference: string | null }[];
}

export interface ReportMeta {
  timezone: string;
  from: string;
  to: string;
}

export interface SalesRow {
  salesCount: number;
  returnsCount: number;
  grossSales: string;
  discounts: string;
  tax: string;
  salesTotal: string;
  refunds: string;
  netSales: string;
}

export interface SalesReport extends ReportMeta {
  totals: SalesRow;
  items: (SalesRow & { period: string })[];
}

export interface PaymentsReport extends ReportMeta {
  revenue: { salesTotal: string; refunds: string; netSales: string };
  cash: { collectedAllMethods: string; refundsPaidOut: string; netCollected: string; pendingRefunds: string };
  note: string;
  methods: { method: string; name: string; isCash: boolean; tendered: string; changeGiven: string; collected: string; refundsCompleted: string; refundsPending: string; refundsFailed: string; netCollected: string }[];
}

export interface CashierReportRow {
  cashierId: string;
  name: string;
  username: string;
  salesCount: number;
  grossSales: string;
  discounts: string;
  salesTotal: string;
  averageSale: string;
  unitsSold: string;
  returnsOnTheirSales: number;
  refunds: string;
  netSales: string;
}

export interface ProductReportRow {
  sku: string;
  description: string;
  quantitySold: string;
  quantityReturned: string;
  netQuantity: string;
  grossSales: string;
  discounts: string;
  revenue: string;
  refunded: string;
  netRevenue: string;
}

export interface TaxReport extends ReportMeta {
  taxEnabled: boolean;
  pricesIncludeTax: boolean;
  note: string;
  totals: { taxCollected: string; taxRefunded: string; netTax: string };
  items: { ratePct: string; label: string; taxableSales: string; taxCollected: string; taxableReturns: string; taxRefunded: string; netTaxableSales: string; netTax: string }[];
}

export interface ShiftReportRow extends ShiftSummary {
  id: number;
  register: string;
  cashier: string;
  openedAt: string;
  closedAt: string | null;
  status: ShiftStatus;
  countedCash: string | null;
  variance: string | null;
  result: "OPEN" | "BALANCED" | "SHORTAGE" | "OVERAGE";
  discrepancy: DiscrepancyStatus;
  approvedBy: string | null;
  approvalNote: string | null;
}

export interface ShiftsReport extends ReportMeta, Paged<ShiftReportRow> {
  totals: { shortage: string; overage: string; net: string; awaitingApproval: number };
}

export interface Page<T> extends Paged<T>, Partial<ReportMeta> {}

export interface ExchangeQuote {
  returnedValue: string;
  issuedValue: string;
  difference: string;
  direction: "PAY" | "REFUND" | "EVEN" | string;
  lines: { variantId: string; description: string; sku: string; quantity: number; lineTotal: string; insufficientStock: boolean; alsoReturned: number }[];
}

export interface Exchange {
  id: string;
  exchangeNumber: string;
  returnedValue: string;
  issuedValue: string;
  difference: string;
  direction: string;
  createdAt: string;
  originalSale: { id: string; saleNumber: string };
  processedBy: { fullName: string };
  return: { returnNumber: string; reason: ReturnReason };
  newSale: { id: string; saleNumber: string };
}

export interface ExchangeReceipt {
  documentType: "EXCHANGE";
  exchangeNumber: string;
  issuedAt: string;
  originalInvoice: string;
  processedBy: string;
  returnedValue: string;
  issuedValue: string;
  difference: string;
  direction: string;
  returned: RefundReceipt;
  issued: Receipt;
}

export type ExportReport = "sales" | "refunds" | "inventory" | "shifts" | "tax" | "products";
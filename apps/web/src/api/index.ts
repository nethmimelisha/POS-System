import { request } from "./client";
import type {
  Category,
  CashMovement,
  Customer,
  CustomerHistory,
  PaymentsReport,
  ProductReportRow,
  RefundReceipt,
  Exchange,
  ExchangeQuote,
  ExchangeReceipt,
  ReturnQuote,
  ReturnReason,
  Returnable,
  SaleReturn,
  SalesReport,
  CashierReportRow,
  Shift,
  ShiftsReport,
  TaxReport,
  ReportMeta,
  LookupVariant,
  LowStockRow,
  ManagedUser,
  Paged,
  PaymentMethod,
  Product,
  Quote,
  QuoteItemInput,
  Discount,
  Receipt,
  Register,
  Role,
  Sale,
  SaleInput,
  SaleSummary,
  Settings,
  StockMovement,
  TaxRate,
  User,
} from "./types";

export const api = {
  login: (username: string, password: string) =>
    request<{ user: User }>("/auth/login", { body: { username, password }, skipAuthRedirect: true }),
  logout: () => request<{ ok: true }>("/auth/logout", { method: "POST", body: {}, skipAuthRedirect: true }),
  me: () => request<{ user: User }>("/auth/me", { skipAuthRedirect: true }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true }>("/auth/change-password", { body: { currentPassword, newPassword } }),

  settings: () => request<Settings>("/settings"),
  updateSettings: (data: Partial<Settings>) => request<Settings>("/settings", { method: "PUT", body: data }),
  registers: () => request<Register[]>("/registers"),
  paymentMethods: () => request<PaymentMethod[]>("/payment-methods"),
  taxRates: () => request<TaxRate[]>("/tax-rates"),
  categories: () => request<Category[]>("/categories"),

  products: (q: { search?: string; page?: number; pageSize?: number; categoryId?: number; active?: boolean }) =>
    request<Paged<Product>>("/products", { query: q }),
  lookup: (code: string) => request<LookupVariant>(`/products/lookup/${encodeURIComponent(code)}`),
  createProduct: (data: unknown) => request<Product>("/products", { body: data }),
  updateProduct: (id: string, data: unknown) => request<Product>(`/products/${id}`, { method: "PATCH", body: data }),
  updateVariant: (id: string, data: unknown) => request<unknown>(`/products/variants/${id}`, { method: "PATCH", body: data }),
  addVariant: (productId: string, data: unknown) => request<unknown>(`/products/${productId}/variants`, { body: data }),

  lowStock: () => request<LowStockRow[]>("/inventory/levels", { query: { lowOnly: true } }),
  adjustStock: (data: { variantId: string; type: "ADJUSTMENT" | "DAMAGE" | "PURCHASE"; quantity: number; reason: string; unitCost?: number }) =>
    request<{ movementId: string; onHand: string }>("/inventory/adjustments", { body: data }),
  movements: (variantId: string) => request<StockMovement[]>("/inventory/movements", { query: { variantId, pageSize: 20 } }),

  quote: (items: QuoteItemInput[], discount: Discount | undefined, signal?: AbortSignal) =>
    request<Quote>("/sales/quote", { body: { items, discount }, signal }),
  createSale: (input: SaleInput) => request<Sale>("/sales", { body: input }),
  sale: (id: string) => request<Sale>(`/sales/${id}`),
  holdSale: (data: { id: string; registerId: number; items: QuoteItemInput[]; discount?: Discount; customerId?: string; notes?: string }) => request<Sale>("/sales/hold", { body: data }),
  voidSale: (id: string, reason: string) => request<Sale>(`/sales/${id}/void`, { body: { reason } }),
  exchangeQuote: (saleId: string, returnItems: { saleItemId: string; quantity: number }[], newItems: QuoteItemInput[]) =>
    request<ExchangeQuote>("/exchanges/quote", { body: { saleId, returnItems, newItems } }),
  createExchange: (data: unknown) => request<Exchange>("/exchanges", { body: data }),
  exchanges: (q: { page?: number; pageSize?: number }) => request<Paged<Exchange>>("/exchanges", { query: q }),
  exchangeReceipt: (id: string) => request<ExchangeReceipt>(`/exchanges/${id}/receipt`),
  receipt: (id: string) => request<Receipt>(`/sales/${id}/receipt`),
  sales: (q: { from?: string; to?: string; page?: number; pageSize?: number; status?: string; search?: string; customerId?: string }) =>
    request<Paged<SaleSummary>>("/sales", { query: q }),

  users: () => request<ManagedUser[]>("/users"),
  createUser: (data: { username: string; fullName: string; password: string; role: Role; email?: string }) =>
    request<ManagedUser>("/users", { body: data }),
  updateUser: (id: string, data: Partial<{ fullName: string; role: Role; isActive: boolean; password: string }>) =>
    request<ManagedUser>(`/users/${id}`, { method: "PATCH", body: data }),
  customers: (q: { search?: string; page?: number; pageSize?: number }) => request<Paged<Customer>>("/customers", { query: q }),
  createCustomer: (data: { name: string; phone?: string | null; email?: string | null; notes?: string | null }) => request<Customer>("/customers", { body: data }),
  updateCustomer: (id: string, data: Partial<{ name: string; phone: string | null; email: string | null; notes: string | null }>) =>
    request<Customer>(`/customers/${id}`, { method: "PATCH", body: data }),
  customerHistory: (id: string, page = 1) => request<CustomerHistory>(`/customers/${id}/history`, { query: { page, pageSize: 10 } }),

  myShift: () => request<Shift | null>("/shifts/mine"),
  registerShift: (registerId: number) => request<Shift | null>("/shifts/current", { query: { registerId } }),
  shifts: (q: { status?: string; discrepancy?: string; page?: number; pageSize?: number }) => request<Paged<Shift>>("/shifts", { query: q }),
  shift: (id: number) => request<Shift>(`/shifts/${id}`),
  openShift: (data: { registerId: number; openingCash: number; cashierId?: string }) => request<Shift>("/shifts/open", { body: data }),
  cashMovement: (id: number, data: { type: CashMovement["type"]; amount: number; reason: string }) => request<Shift>(`/shifts/${id}/cash-movements`, { body: data }),
  closeShift: (id: number, data: { countedCash: number; notes?: string }) => request<Shift>(`/shifts/${id}/close`, { body: data }),
  approveShift: (id: number, note: string) => request<Shift>(`/shifts/${id}/approve`, { body: { note } }),

  returnable: (saleId: string) => request<Returnable>(`/returns/sale/${saleId}/returnable`),
  returnQuote: (saleId: string, items: { saleItemId: string; quantity: number }[]) => request<ReturnQuote>("/returns/quote", { body: { saleId, items } }),
  createReturn: (data: {
    id: string;
    saleId: string;
    registerId: number;
    reason: ReturnReason;
    notes?: string;
    items: { saleItemId: string; quantity: number; resellable: boolean }[];
    refunds: { method: string; amount: number; reference?: string }[];
  }) => request<SaleReturn>("/returns", { body: data }),
  returns: (q: { search?: string; pendingRefunds?: boolean; page?: number; pageSize?: number }) => request<Paged<SaleReturn>>("/returns", { query: q }),
  returnReceipt: (id: string) => request<RefundReceipt>(`/returns/${id}/receipt`),
  confirmRefund: (returnId: string, refundId: number, providerReference: string) =>
    request<SaleReturn>(`/returns/${returnId}/refunds/${refundId}/confirm`, { body: { providerReference } }),
  failRefund: (returnId: string, refundId: number, reason: string) => request<SaleReturn>(`/returns/${returnId}/refunds/${refundId}/fail`, { body: { reason } }),
  reissueRefund: (returnId: string, data: { method: string; amount: number; reference?: string }) => request<SaleReturn>(`/returns/${returnId}/refunds`, { body: data }),

  reportSales: (q: { from?: string; to?: string; groupBy: string }) => request<SalesReport>("/reports/sales", { query: q }),
  reportPayments: (q: { from?: string; to?: string }) => request<PaymentsReport>("/reports/payments", { query: q }),
  reportCashiers: (q: { from?: string; to?: string; page?: number }) => request<Paged<CashierReportRow> & ReportMeta>("/reports/cashiers", { query: q }),
  reportProducts: (q: { from?: string; to?: string; search?: string; page?: number }) => request<Paged<ProductReportRow> & ReportMeta>("/reports/products", { query: q }),
  reportTax: (q: { from?: string; to?: string }) => request<TaxReport>("/reports/tax", { query: q }),
  reportLowStock: (page = 1) => request<Paged<LowStockRow & { shortBy: string }>>("/reports/low-stock", { query: { page, pageSize: 25 } }),
  reportShifts: (q: { from?: string; to?: string; discrepancyOnly?: boolean; page?: number }) => request<ShiftsReport>("/reports/shifts", { query: q }),
};

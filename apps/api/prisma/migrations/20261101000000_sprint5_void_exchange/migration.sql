-- Sprint 5: sale voids, exchanges and the internal exchange-credit payment method.
ALTER TABLE "PaymentMethod" ADD COLUMN "isSystem" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Sale" ADD COLUMN "voidedAt" TIMESTAMP(3),
ADD COLUMN "voidedById" TEXT,
ADD COLUMN "voidReason" TEXT;

ALTER TABLE "Sale" ADD CONSTRAINT "Sale_voidedById_fkey" FOREIGN KEY ("voidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A voided sale must say who voided it, when and why.
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_void_fields_check" CHECK (
  ("status" <> 'VOIDED') OR ("voidedAt" IS NOT NULL AND "voidedById" IS NOT NULL AND "voidReason" IS NOT NULL)
);

-- Exchange credit settles the returned value against the replacement sale. Inactive so it can never be chosen at checkout or refund.
INSERT INTO "PaymentMethod" ("code", "name", "isCash", "isActive", "isSystem")
VALUES ('exchange_credit', 'Exchange credit', false, false, true);

CREATE TABLE "Exchange" (
    "id" TEXT NOT NULL,
    "exchangeNumber" TEXT NOT NULL,
    "originalSaleId" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "newSaleId" TEXT NOT NULL,
    "registerId" INTEGER,
    "processedById" TEXT NOT NULL,
    "returnedValue" DECIMAL(12,2) NOT NULL,
    "issuedValue" DECIMAL(12,2) NOT NULL,
    "difference" DECIMAL(12,2) NOT NULL,
    "requestHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Exchange_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Exchange_exchangeNumber_key" ON "Exchange"("exchangeNumber");
CREATE UNIQUE INDEX "Exchange_returnId_key" ON "Exchange"("returnId");
CREATE UNIQUE INDEX "Exchange_newSaleId_key" ON "Exchange"("newSaleId");
CREATE INDEX "Exchange_originalSaleId_idx" ON "Exchange"("originalSaleId");
CREATE INDEX "Exchange_createdAt_idx" ON "Exchange"("createdAt");

ALTER TABLE "Exchange" ADD CONSTRAINT "Exchange_originalSaleId_fkey" FOREIGN KEY ("originalSaleId") REFERENCES "Sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Exchange" ADD CONSTRAINT "Exchange_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "SaleReturn"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Exchange" ADD CONSTRAINT "Exchange_newSaleId_fkey" FOREIGN KEY ("newSaleId") REFERENCES "Sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Exchange" ADD CONSTRAINT "Exchange_processedById_fkey" FOREIGN KEY ("processedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
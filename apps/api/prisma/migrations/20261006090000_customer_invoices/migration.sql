ALTER TYPE "InvoiceStatus" ADD VALUE IF NOT EXISTS 'DRAFT';
ALTER TYPE "InvoiceStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
CREATE TYPE "InvoiceItemKind" AS ENUM ('SERVICE', 'ADD_ON', 'PRODUCT', 'CUSTOM');
CREATE TYPE "DiscountKind" AS ENUM ('NONE', 'FLAT', 'PERCENT');

ALTER TABLE "Organization"
  ADD COLUMN "gstRateBps" INTEGER,
  ADD COLUMN "gstin" TEXT,
  ADD COLUMN "invoiceAddress" TEXT,
  ADD COLUMN "invoicePhone" TEXT,
  ADD COLUMN "allowCustomInvoiceItems" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "employeeAddons" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_gstRateBps_check" CHECK ("gstRateBps" IS NULL OR "gstRateBps" BETWEEN 0 AND 10000);

ALTER TABLE "Job" ADD COLUMN "servicePricePaise" INTEGER DEFAULT 0;
ALTER TABLE "Job" ADD COLUMN "serviceTaxRateBps" INTEGER DEFAULT 0;
UPDATE "Job" SET "servicePricePaise" = "subtotalPaise", "serviceTaxRateBps" = CASE WHEN "subtotalPaise" > 0 THEN ROUND("taxPaise" * 10000.0 / "subtotalPaise")::INTEGER ELSE 0 END;
ALTER TABLE "Job" ALTER COLUMN "servicePricePaise" SET NOT NULL;
ALTER TABLE "Job" ALTER COLUMN "serviceTaxRateBps" SET NOT NULL;

ALTER TABLE "Invoice"
  ADD COLUMN "discountKind" "DiscountKind" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "discountValue" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "discountPaise" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "taxablePaise" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "replacesInvoiceId" TEXT,
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
UPDATE "Invoice" SET "taxablePaise" = "subtotalPaise", "createdAt" = "issuedAt";
ALTER TABLE "Invoice" ALTER COLUMN "issuedAt" DROP NOT NULL;
ALTER TABLE "Invoice" ALTER COLUMN "issuedAt" DROP DEFAULT;
ALTER TABLE "Invoice" ALTER COLUMN "status" SET DEFAULT 'DRAFT';
DROP INDEX "Invoice_jobId_key";
DROP INDEX "Invoice_jobId_organizationId_key";
CREATE INDEX "Invoice_organizationId_jobId_status_idx" ON "Invoice"("organizationId", "jobId", "status");
CREATE UNIQUE INDEX "Invoice_one_active_per_job" ON "Invoice"("jobId") WHERE "status" <> 'CANCELLED';

CREATE TABLE "SaleItem" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "kind" "InvoiceItemKind" NOT NULL,
  "name" TEXT NOT NULL,
  "pricePaise" INTEGER NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SaleItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SaleItem_price_check" CHECK ("pricePaise" >= 0)
);
CREATE UNIQUE INDEX "SaleItem_id_organizationId_key" ON "SaleItem"("id", "organizationId");
CREATE UNIQUE INDEX "SaleItem_organizationId_kind_name_key" ON "SaleItem"("organizationId", "kind", "name");
CREATE INDEX "SaleItem_organizationId_kind_active_idx" ON "SaleItem"("organizationId", "kind", "active");
ALTER TABLE "SaleItem" ADD CONSTRAINT "SaleItem_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "InvoiceItem" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "invoiceId" TEXT NOT NULL,
  "saleItemId" TEXT,
  "kind" "InvoiceItemKind" NOT NULL,
  "description" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "unitPricePaise" INTEGER NOT NULL,
  "subtotalPaise" INTEGER NOT NULL,
  "taxRateBps" INTEGER NOT NULL,
  "taxPaise" INTEGER NOT NULL,
  "totalPaise" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InvoiceItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InvoiceItem_values_check" CHECK ("quantity" > 0 AND "unitPricePaise" >= 0 AND "subtotalPaise" >= 0 AND "taxRateBps" BETWEEN 0 AND 10000 AND "taxPaise" >= 0 AND "totalPaise" >= 0)
);
CREATE INDEX "InvoiceItem_organizationId_invoiceId_idx" ON "InvoiceItem"("organizationId", "invoiceId");
ALTER TABLE "InvoiceItem" ADD CONSTRAINT "InvoiceItem_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InvoiceItem" ADD CONSTRAINT "InvoiceItem_invoiceId_organizationId_fkey" FOREIGN KEY ("invoiceId", "organizationId") REFERENCES "Invoice"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InvoiceItem" ADD CONSTRAINT "InvoiceItem_saleItemId_organizationId_fkey" FOREIGN KEY ("saleItemId", "organizationId") REFERENCES "SaleItem"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "InvoiceItem" ("id", "organizationId", "invoiceId", "kind", "description", "quantity", "unitPricePaise", "subtotalPaise", "taxRateBps", "taxPaise", "totalPaise")
SELECT 'legacy-' || i."id", i."organizationId", i."id", 'SERVICE', j."serviceName", 1, i."subtotalPaise", i."subtotalPaise", 0, i."taxPaise", i."totalPaise"
FROM "Invoice" i JOIN "Job" j ON j."id" = i."jobId";

CREATE FUNCTION protect_issued_invoice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."status" <> 'DRAFT' AND (
    NEW."organizationId", NEW."jobId", NEW."invoiceNumber", NEW."subtotalPaise", NEW."discountKind", NEW."discountValue", NEW."discountPaise", NEW."taxablePaise", NEW."taxPaise", NEW."totalPaise", NEW."issuedAt"
  ) IS DISTINCT FROM (
    OLD."organizationId", OLD."jobId", OLD."invoiceNumber", OLD."subtotalPaise", OLD."discountKind", OLD."discountValue", OLD."discountPaise", OLD."taxablePaise", OLD."taxPaise", OLD."totalPaise", OLD."issuedAt"
  ) THEN RAISE EXCEPTION 'Issued invoice financial fields are immutable'; END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Invoices cannot be deleted'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_invoice BEFORE UPDATE OR DELETE ON "Invoice" FOR EACH ROW EXECUTE FUNCTION protect_issued_invoice();

CREATE FUNCTION protect_issued_invoice_item() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE state "InvoiceStatus";
BEGIN
  SELECT "status" INTO state FROM "Invoice" WHERE "id" = COALESCE(NEW."invoiceId", OLD."invoiceId");
  IF state <> 'DRAFT' THEN RAISE EXCEPTION 'Issued invoice items are immutable'; END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER protect_invoice_item BEFORE INSERT OR UPDATE OR DELETE ON "InvoiceItem" FOR EACH ROW EXECUTE FUNCTION protect_issued_invoice_item();

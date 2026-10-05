CREATE OR REPLACE FUNCTION protect_issued_invoice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Invoices cannot be deleted'; END IF;
  IF OLD."status" <> 'DRAFT' AND (
    NEW."organizationId", NEW."jobId", NEW."invoiceNumber", NEW."subtotalPaise", NEW."discountKind", NEW."discountValue", NEW."discountPaise", NEW."taxablePaise", NEW."taxPaise", NEW."totalPaise", NEW."issuedAt"
  ) IS DISTINCT FROM (
    OLD."organizationId", OLD."jobId", OLD."invoiceNumber", OLD."subtotalPaise", OLD."discountKind", OLD."discountValue", OLD."discountPaise", OLD."taxablePaise", OLD."taxPaise", OLD."totalPaise", OLD."issuedAt"
  ) THEN RAISE EXCEPTION 'Issued invoice financial fields are immutable'; END IF;
  IF (OLD."status" = 'ISSUED' AND NEW."status" NOT IN ('ISSUED', 'PARTIALLY_PAID', 'PAID', 'CANCELLED'))
    OR (OLD."status" = 'PARTIALLY_PAID' AND NEW."status" NOT IN ('PARTIALLY_PAID', 'PAID'))
    OR (OLD."status" = 'PAID' AND NEW."status" <> 'PAID')
    OR (OLD."status" = 'CANCELLED' AND NEW."status" <> 'CANCELLED')
  THEN RAISE EXCEPTION 'Invalid invoice status transition'; END IF;
  IF NEW."status" = 'CANCELLED' AND OLD."status" <> 'CANCELLED' AND EXISTS (SELECT 1 FROM "Payment" WHERE "invoiceId" = OLD."id") THEN
    RAISE EXCEPTION 'Invoices with payments cannot be cancelled';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION protect_issued_invoice_item() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_state "InvoiceStatus";
DECLARE new_state "InvoiceStatus";
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT "status" INTO old_state FROM "Invoice" WHERE "id" = OLD."invoiceId";
    IF old_state <> 'DRAFT' THEN RAISE EXCEPTION 'Issued invoice items are immutable'; END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT "status" INTO new_state FROM "Invoice" WHERE "id" = NEW."invoiceId";
    IF new_state <> 'DRAFT' THEN RAISE EXCEPTION 'Issued invoice items are immutable'; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION protect_payment_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Payments are append-only; use an audited correction workflow';
END $$;
CREATE TRIGGER protect_payment BEFORE UPDATE OR DELETE ON "Payment" FOR EACH ROW EXECUTE FUNCTION protect_payment_history();

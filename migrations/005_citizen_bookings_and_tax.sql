-- Migration 005: Citizen Bookings and Tax Schema Updates & Reference Seed Data
SET client_encoding = 'UTF8';

-- 1. Modify booking_details to allow NULL request_id (for direct bookings)
ALTER TABLE booking_details ALTER COLUMN request_id DROP NOT NULL;

-- 2. booking_details.user_id
ALTER TABLE booking_details ADD COLUMN IF NOT EXISTS user_id BIGINT NULL;
CREATE INDEX IF NOT EXISTS idx_booking_user_date ON booking_details (user_id, booking_date);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_booking_user'
  ) THEN
    ALTER TABLE booking_details ADD CONSTRAINT fk_booking_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- booking_details.booking_code
ALTER TABLE booking_details ADD COLUMN IF NOT EXISTS booking_code VARCHAR(32) NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_booking_code'
  ) THEN
    ALTER TABLE booking_details ADD CONSTRAINT uq_booking_code UNIQUE (booking_code);
  END IF;
END $$;

-- tax_accounts.user_id
ALTER TABLE tax_accounts ADD COLUMN IF NOT EXISTS user_id BIGINT NULL;
CREATE INDEX IF NOT EXISTS idx_tax_accounts_user ON tax_accounts (user_id);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_tax_accounts_user'
  ) THEN
    ALTER TABLE tax_accounts ADD CONSTRAINT fk_tax_accounts_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- tax_payments.user_id
ALTER TABLE tax_payments ADD COLUMN IF NOT EXISTS user_id BIGINT NULL;
CREATE INDEX IF NOT EXISTS idx_tax_payments_user_paid ON tax_payments (user_id, paid_at);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_tax_payments_user'
  ) THEN
    ALTER TABLE tax_payments ADD CONSTRAINT fk_tax_payments_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- tax_payments.description
ALTER TABLE tax_payments ADD COLUMN IF NOT EXISTS description VARCHAR(255) NULL;

-- tax_payments.status
ALTER TABLE tax_payments ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'COMPLETED';

-- tax_payments.payment_method
ALTER TABLE tax_payments ADD COLUMN IF NOT EXISTS payment_method VARCHAR(50) NOT NULL DEFAULT 'ONLINE';

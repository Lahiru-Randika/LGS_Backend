-- Migration 005: Citizen Bookings and Tax Schema Updates & Reference Seed Data
SET NAMES utf8mb4;

-- 1. Modify booking_details to allow NULL request_id (for direct bookings)
ALTER TABLE booking_details MODIFY COLUMN request_id BIGINT UNSIGNED NULL;

-- 2. Add columns to booking_details if not already added
DROP PROCEDURE IF EXISTS _patch_schema_005;
CREATE PROCEDURE _patch_schema_005()
BEGIN
  -- booking_details.user_id
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS 
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'booking_details' AND COLUMN_NAME = 'user_id'
  ) THEN
    ALTER TABLE booking_details ADD COLUMN user_id BIGINT UNSIGNED NULL AFTER request_id;
    ALTER TABLE booking_details ADD KEY idx_booking_user_date (user_id, booking_date);
    ALTER TABLE booking_details ADD CONSTRAINT fk_booking_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;

  -- booking_details.booking_code
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS 
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'booking_details' AND COLUMN_NAME = 'booking_code'
  ) THEN
    ALTER TABLE booking_details ADD COLUMN booking_code VARCHAR(32) NULL AFTER id;
    ALTER TABLE booking_details ADD UNIQUE KEY uq_booking_code (booking_code);
  END IF;

  -- tax_accounts.user_id
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS 
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tax_accounts' AND COLUMN_NAME = 'user_id'
  ) THEN
    ALTER TABLE tax_accounts ADD COLUMN user_id BIGINT UNSIGNED NULL AFTER id;
    ALTER TABLE tax_accounts ADD KEY idx_tax_accounts_user (user_id);
    ALTER TABLE tax_accounts ADD CONSTRAINT fk_tax_accounts_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;

  -- tax_payments.user_id
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS 
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tax_payments' AND COLUMN_NAME = 'user_id'
  ) THEN
    ALTER TABLE tax_payments ADD COLUMN user_id BIGINT UNSIGNED NULL AFTER id;
    ALTER TABLE tax_payments ADD KEY idx_tax_payments_user_paid (user_id, paid_at);
    ALTER TABLE tax_payments ADD CONSTRAINT fk_tax_payments_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;

  -- tax_payments.description
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS 
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tax_payments' AND COLUMN_NAME = 'description'
  ) THEN
    ALTER TABLE tax_payments ADD COLUMN description VARCHAR(255) NULL AFTER amount;
  END IF;

  -- tax_payments.status
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS 
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tax_payments' AND COLUMN_NAME = 'status'
  ) THEN
    ALTER TABLE tax_payments ADD COLUMN status VARCHAR(30) NOT NULL DEFAULT 'COMPLETED' AFTER payment_reference;
  END IF;

  -- tax_payments.payment_method
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS 
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tax_payments' AND COLUMN_NAME = 'payment_method'
  ) THEN
    ALTER TABLE tax_payments ADD COLUMN payment_method VARCHAR(50) NOT NULL DEFAULT 'ONLINE' AFTER status;
  END IF;
END;

CALL _patch_schema_005();
DROP PROCEDURE IF EXISTS _patch_schema_005;

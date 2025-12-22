-- Adds transfer box fields to CashShift and introduces CashShiftMovement (manual IN/OUT movements).
-- Run this against your MariaDB/MySQL database.

-- 1) Extend CashShift
ALTER TABLE CashShift
  ADD COLUMN openingTransfer DECIMAL(10,2) NOT NULL DEFAULT 0 AFTER openingCash,
  ADD COLUMN closingTransfer DECIMAL(10,2) NULL AFTER closingCash;

-- 2) Manual movements inside a shift (expenses/withdrawals/adjustments)
CREATE TABLE IF NOT EXISTS CashShiftMovement (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shiftId BIGINT UNSIGNED NOT NULL,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  createdBy BIGINT UNSIGNED NULL,
  direction ENUM('IN','OUT') NOT NULL,
  method ENUM('CASH','TRANSFER') NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  category VARCHAR(50) NULL,
  note VARCHAR(255) NULL,
  PRIMARY KEY (id),
  KEY idx_shift_createdAt (shiftId, createdAt),
  KEY idx_createdBy (createdBy),
  CONSTRAINT fk_cashshiftmovement_shift FOREIGN KEY (shiftId) REFERENCES CashShift(id) ON DELETE CASCADE,
  CONSTRAINT fk_cashshiftmovement_user  FOREIGN KEY (createdBy) REFERENCES User(id) ON DELETE SET NULL
);

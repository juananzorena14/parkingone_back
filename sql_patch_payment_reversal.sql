-- Adds reversal tracking to Payment (keeps full audit trail)
-- Run manually in MySQL.

ALTER TABLE Payment
  ADD COLUMN reversesPaymentId INT NULL AFTER ticketId,
  ADD COLUMN reverseReason VARCHAR(255) NULL AFTER reversesPaymentId;

-- Prevent multiple reversals for the same original payment
CREATE UNIQUE INDEX ux_payment_reversesPaymentId ON Payment(reversesPaymentId);

-- Helpful indexes for filtering
CREATE INDEX ix_payment_createdAt ON Payment(createdAt);
CREATE INDEX ix_payment_ticketId ON Payment(ticketId);
CREATE INDEX ix_payment_method ON Payment(method);
CREATE INDEX ix_payment_reversesPaymentId ON Payment(reversesPaymentId);

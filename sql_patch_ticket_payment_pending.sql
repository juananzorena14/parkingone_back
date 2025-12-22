-- Adds PAYMENT_PENDING status to Ticket.status to support partial/split payments.
-- Run this against your MariaDB/MySQL database (adjust schema/database selection as needed).

-- Before:
--   status ENUM('OPEN','CLOSED','CANCELED')
-- After:
--   status ENUM('OPEN','PAYMENT_PENDING','CLOSED','CANCELED')

ALTER TABLE Ticket
  MODIFY status ENUM('OPEN','PAYMENT_PENDING','CLOSED','CANCELED') NOT NULL DEFAULT 'OPEN';

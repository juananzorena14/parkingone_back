const PAYMENT_METHODS = ['CASH', 'DEBIT', 'CREDIT', 'TRANSFER'];

function normalizePaymentMethod(method) {
  const m = String(method || '').trim().toUpperCase();
  if (!m) return null;

  // Legacy aliases kept for backwards-compat with existing DB rows
  if (m === 'MP') return 'TRANSFER';
  if (m === 'STRIPE') return 'CREDIT';

  if (PAYMENT_METHODS.includes(m)) return m;

  // Safety fallback: treat unknown non-empty methods as TRANSFER (non-cash box)
  // so shift totals don't silently drop money.
  if (m === 'CASH') return 'CASH';
  return 'TRANSFER';
}

function isValidPaymentMethod(method) {
  const m = String(method || '').trim().toUpperCase();
  return PAYMENT_METHODS.includes(m);
}

function methodToBox(method) {
  const m = normalizePaymentMethod(method);
  if (!m) return null;
  return m === 'CASH' ? 'CASH' : 'TRANSFER';
}

module.exports = {
  PAYMENT_METHODS,
  normalizePaymentMethod,
  isValidPaymentMethod,
  methodToBox,
};

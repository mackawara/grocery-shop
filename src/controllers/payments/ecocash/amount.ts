// Direct EcoCash amounts use integer USD cents internally. Decimal strings are
// accepted at the boundary so unsupported precision is rejected, never rounded.
export const parseUsdCents = (amount: string, currency: string): number => {
  if (currency !== 'USD' || !/^(0|[1-9]\d*)(?:\.\d{1,2})?$/.test(amount)) {
    throw new Error('Expected a USD amount with at most two decimal places');
  }
  const [whole, fraction = ''] = amount.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw new Error('USD amount must be positive and within the safe cents range');
  }
  return cents;
};

export interface UsdLineItem {
  unitAmount: string;
  currency: string;
  quantity: number;
}

export interface UsdOrderTotal {
  itemSubtotalCents: number;
  deliveryFeeCents: number;
  totalCents: number;
}

// The accepted fee is a component of the total, never an increment applied to
// an existing order total. Callers must bind these values to checkout consent.
export const calculateUsdOrderTotal = (
  items: readonly UsdLineItem[],
  deliveryFee: { amount: string; currency: string },
): UsdOrderTotal => {
  if (items.length === 0) {
    throw new Error('At least one item is required');
  }
  let itemSubtotalCents = 0;
  for (const item of items) {
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
      throw new Error('Item quantity must be a positive safe integer');
    }
    itemSubtotalCents += parseUsdCents(item.unitAmount, item.currency) * item.quantity;
    if (!Number.isSafeInteger(itemSubtotalCents)) {
      throw new Error('Item subtotal exceeds the safe cents range');
    }
  }
  const deliveryFeeCents =
    deliveryFee.currency === 'USD' && /^(?:0|0\.0{1,2})$/.test(deliveryFee.amount)
      ? 0
      : parseUsdCents(deliveryFee.amount, deliveryFee.currency);
  const totalCents = itemSubtotalCents + deliveryFeeCents;
  if (!Number.isSafeInteger(totalCents)) {
    throw new Error('Order total exceeds the safe cents range');
  }
  return { itemSubtotalCents, deliveryFeeCents, totalCents };
};

import { Currency } from './models.ts';

// The single currency orders are priced and charged in. `Order.totalAmount` has
// no currency of its own, so every amount folded into it — item prices, the
// delivery fee — must be in this one. Until orders carry a currency, anything
// priced differently cannot be charged, so rate cells and manual fees are held
// to it at the edge rather than failing at payment time.
export const ORDER_CURRENCY = Currency.USD;

// "Try again" button id carries the order number so the reply handler can
// re-charge it without a session lookup.
export const PAYMENT_RETRY_BUTTON_ID_PREFIX = 'retry_payment:';

export const buildPaymentRetryButtonId = (orderNumber: string): string =>
  `${PAYMENT_RETRY_BUTTON_ID_PREFIX}${orderNumber}`;

export const parsePaymentRetryButtonId = (id: string): string | undefined =>
  id.startsWith(PAYMENT_RETRY_BUTTON_ID_PREFIX)
    ? id.slice(PAYMENT_RETRY_BUTTON_ID_PREFIX.length)
    : undefined;

// "Try again" button id carries the order number so the reply handler can
// re-charge it without a session lookup.
export const PAYMENT_RETRY_BUTTON_ID_PREFIX = 'retry_payment:';

export const buildPaymentRetryButtonId = (orderNumber: string): string =>
  `${PAYMENT_RETRY_BUTTON_ID_PREFIX}${orderNumber}`;

export const parsePaymentRetryButtonId = (id: string): string | undefined =>
  id.startsWith(PAYMENT_RETRY_BUTTON_ID_PREFIX)
    ? id.slice(PAYMENT_RETRY_BUTTON_ID_PREFIX.length)
    : undefined;

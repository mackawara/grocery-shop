// WhatsApp reply-button ids for the delivery-quote confirmation step. Same
// pattern as payments.ts: the orderNumber rides in the id so the reply handler
// can correlate the tap back to the order without a Redis session.

export const DELIVERY_CONFIRM_BUTTON_ID_PREFIX = 'delivery_confirm:';
export const DELIVERY_COLLECT_BUTTON_ID_PREFIX = 'delivery_collect:';

export const buildDeliveryConfirmButtonId = (orderNumber: string): string =>
  `${DELIVERY_CONFIRM_BUTTON_ID_PREFIX}${orderNumber}`;

export const buildDeliveryCollectButtonId = (orderNumber: string): string =>
  `${DELIVERY_COLLECT_BUTTON_ID_PREFIX}${orderNumber}`;

export const parseDeliveryConfirmButtonId = (id: string): string | undefined =>
  id.startsWith(DELIVERY_CONFIRM_BUTTON_ID_PREFIX)
    ? id.slice(DELIVERY_CONFIRM_BUTTON_ID_PREFIX.length)
    : undefined;

export const parseDeliveryCollectButtonId = (id: string): string | undefined =>
  id.startsWith(DELIVERY_COLLECT_BUTTON_ID_PREFIX)
    ? id.slice(DELIVERY_COLLECT_BUTTON_ID_PREFIX.length)
    : undefined;

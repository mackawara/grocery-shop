export const WHATSAPP: string = 'whatsapp';
export const INTERACTIVE: string = 'interactive';
export const INDIVIDUAL: string = 'individual';
export const ENGLISH_US: string = 'en_US';
export const WA_MESSAGE_TTL_SECONDS: number = 86400;

// Persisted WhatsApp message vocabulary — the single source of truth for the
// WhatsappMessage schema enums, the model's exported unions, and the outbound
// senders. Intentionally decoupled from the inbound-only `MessageNotification`
// payload: it covers inbound notification types AND outbound-only types such as
// 'template' (used to initiate conversations, e.g. vendor signup OTP), which
// never appear on an inbound webhook. The `*_TYPES` arrays feed Mongoose enums;
// the keyed objects (e.g. WA_MESSAGE_TYPE.TEMPLATE) are for call sites.
export const WA_MESSAGE_TYPE = {
  TEXT: 'text',
  INTERACTIVE: 'interactive',
  ORDER: 'order',
  REACTION: 'reaction',
  LOCATION: 'location',
  TEMPLATE: 'template',
} as const;
export type WaMessageType = (typeof WA_MESSAGE_TYPE)[keyof typeof WA_MESSAGE_TYPE];
export const WA_MESSAGE_TYPES = Object.values(WA_MESSAGE_TYPE);

export const WA_INTERACTIVE_TYPE = {
  BUTTON_REPLY: 'button_reply',
  LIST_REPLY: 'list_reply',
  NFM_REPLY: 'nfm_reply',
  FLOW: 'flow',
  BUTTON: 'button',
  LIST: 'list',
  PRODUCT_LIST: 'product_list',
  CATALOG_MESSAGE: 'catalog_message',
  CTA_URL: 'cta_url',
  LOCATION_REQUEST_MESSAGE: 'location_request_message',
} as const;
export type WaInteractiveType = (typeof WA_INTERACTIVE_TYPE)[keyof typeof WA_INTERACTIVE_TYPE];
export const WA_INTERACTIVE_TYPES = Object.values(WA_INTERACTIVE_TYPE);

export const WA_MESSAGE_DIRECTION = {
  INBOUND: 'inbound',
  OUTBOUND: 'outbound',
} as const;
export type WaMessageDirection = (typeof WA_MESSAGE_DIRECTION)[keyof typeof WA_MESSAGE_DIRECTION];
export const WA_MESSAGE_DIRECTIONS = Object.values(WA_MESSAGE_DIRECTION);

export const WA_MESSAGE_STATUS = {
  RECEIVED: 'received',
  SENT: 'sent',
  FAILED: 'failed',
} as const;
export type WaMessageStatus = (typeof WA_MESSAGE_STATUS)[keyof typeof WA_MESSAGE_STATUS];
export const WA_MESSAGE_STATUSES = Object.values(WA_MESSAGE_STATUS);

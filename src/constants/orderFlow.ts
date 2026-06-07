/**
 * WhatsApp Flow JSON for the order capture flow.
 *
 * Single screen (modelled after WhatsApp Flow JSON v7.3):
 *   ORDER_DETAILS — name, payment method (+ conditional ecocash number),
 *                   delivery method, and the delivery-address fields. The
 *                   Footer `complete`s the flow in one step (no navigation).
 *
 * Conditional rendering (evaluated client-side via `visible` / `required`):
 *   - ecocash_number is shown (and required) only when payment_method === 'ecocash'.
 *   - the delivery-address fields (street/suburb/area/town) are shown (and
 *     required) only when delivery_method === DeliveryMethod.DOOR_DELIVERY,
 *     i.e. the option that actually needs an address. Collect/pickup hides them.
 */

import {
  DeliveryMethod as DeliveryMethodEnum,
  PaymentMethod as PaymentMethodEnum,
  toPaymentMethodOptions,
  toDeliveryMethodOptions,
} from './models';

// Fallback Meta flow id for the order-details flow. Tenants carry their own id
// in `whatsappFlowIds.order`; this is only used when that is unset (e.g. local
// dev before the env var is configured).
export const DEFAULT_ORDER_FLOW_ID = '1310221120578634';

// flow_token sent with the order-details flow and echoed back by Meta inside
// `nfm_reply.response_json` on completion. The nfm-reply handler switches on
// this value to route the captured payload to `orderFlowHandler`.
// TODO: replace with a per-order token so flow responses correlate to a
// specific order instead of being looked up by sender.
export const ORDER_DETAILS_FLOW_TOKEN = 'orders_flow_token';

export const ORDER_FLOW_SCREENS = {
  ORDER_DETAILS: 'ORDER_DETAILS',
  DELIVERY_ADDRESS: 'DELIVERY_ADDRESS',
} as const;

export type OrderFlowScreen = (typeof ORDER_FLOW_SCREENS)[keyof typeof ORDER_FLOW_SCREENS];

export const PAYMENT_METHODS = {
  ECOCASH: 'ecocash',
  CASH: 'cash',
  CARD: 'card',
} as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[keyof typeof PAYMENT_METHODS];

export const DELIVERY_METHODS = {
  DELIVERY: 'delivery',
  PICKUP: 'pickup',
} as const;

export type DeliveryMethod = (typeof DELIVERY_METHODS)[keyof typeof DELIVERY_METHODS];

export const PAYMENT_METHOD_OPTIONS = [
  { id: PAYMENT_METHODS.ECOCASH, title: 'EcoCash' },
  { id: PAYMENT_METHODS.CASH, title: 'Cash on delivery / pickup' },
  { id: PAYMENT_METHODS.CARD, title: 'Card' },
];

export const DELIVERY_METHOD_OPTIONS = [
  { id: DELIVERY_METHODS.DELIVERY, title: 'Delivery' },
  { id: DELIVERY_METHODS.PICKUP, title: 'Pickup' },
];

/**
 * Shape of the payload pushed to the server on each data_exchange.
 * Useful when typing the flowsHandler.
 */
export interface OrderDetailsPayload {
  full_name: string;
  payment_method: PaymentMethod;
  ecocash_number?: string;
  delivery_method: DeliveryMethod;
}

export interface DeliveryAddressPayload {
  street: string;
  suburb: string;
  area: string;
  town: string;
}

/**
 * The full payload echoed back through `nfm_reply.response_json` when the flow
 * completes. It is the union of the `complete` action payload plus the
 * `flow_token` Meta injects. Address fields are optional because they are only
 * collected for the door-delivery option. Method values arrive as the
 * `PaymentMethod` / `DeliveryMethod` enum strings from `constants/models`.
 */
export interface OrderFlowResponse extends OrderDetailsPayload, Partial<DeliveryAddressPayload> {
  flow_token?: string;
}

// Conditional expressions must be wrapped in backticks for WhatsApp Flows.
// Address fields render only for the delivery option that needs an address.
const NEEDS_ADDRESS = `\`\${form.delivery_method == '${DeliveryMethodEnum.DOOR_DELIVERY}'}\``;
const NEEDS_ECOCASH = "`${form.payment_method == 'ecocash'}`";

export const ORDER_FLOW_JSON = {
  version: '7.3',
  data_api_version: '3.0',
  routing_model: {
    [ORDER_FLOW_SCREENS.ORDER_DETAILS]: [],
  },
  screens: [
    {
      id: ORDER_FLOW_SCREENS.ORDER_DETAILS,
      title: 'Order Details',
      terminal: true,
      data: {
        payment_methods: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
            },
          },
          __example__: toPaymentMethodOptions(Object.values(PaymentMethodEnum)),
        },
        delivery_methods: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
            },
          },
          __example__: toDeliveryMethodOptions(Object.values(DeliveryMethodEnum)),
        },
      },
      layout: {
        type: 'SingleColumnLayout',
        children: [
          {
            type: 'Form',
            name: 'order_form',
            children: [
              {
                type: 'TextSubheading',
                text: 'Tell us about your order',
              },
              {
                type: 'TextInput',
                name: 'full_name',
                label: 'Full name',
                required: true,
                'input-type': 'text',
                'helper-text': 'Name to appear on the order',
              },
              {
                type: 'RadioButtonsGroup',
                name: 'payment_method',
                label: 'Payment method',
                required: true,
                'data-source': '${data.payment_methods}',
              },
              {
                type: 'TextInput',
                name: 'ecocash_number',
                label: 'EcoCash number',
                required: NEEDS_ECOCASH,
                visible: NEEDS_ECOCASH,
                'input-type': 'phone',
                'helper-text': 'Number that will receive the payment prompt',
              },
              {
                type: 'RadioButtonsGroup',
                name: 'delivery_method',
                label: 'Delivery method',
                required: true,
                'data-source': '${data.delivery_methods}',
              },
              {
                type: 'TextSubheading',
                text: 'Where should we deliver?',
                visible: NEEDS_ADDRESS,
              },
              {
                type: 'TextInput',
                name: 'street',
                label: 'Street',
                required: NEEDS_ADDRESS,
                visible: NEEDS_ADDRESS,
                'input-type': 'text',
                'helper-text': 'House number and street',
              },
              {
                type: 'TextInput',
                name: 'suburb',
                label: 'Suburb / Location',
                required: NEEDS_ADDRESS,
                visible: NEEDS_ADDRESS,
                'input-type': 'text',
              },
              {
                type: 'TextInput',
                name: 'area',
                label: 'Area',
                required: NEEDS_ADDRESS,
                visible: NEEDS_ADDRESS,
                'input-type': 'text',
              },
              {
                type: 'TextInput',
                name: 'town',
                label: 'Town / City',
                required: NEEDS_ADDRESS,
                visible: NEEDS_ADDRESS,
                'input-type': 'text',
              },
              {
                type: 'Footer',
                label: 'Submit order',
                'on-click-action': {
                  name: 'complete',
                  payload: {
                    full_name: '${form.full_name}',
                    payment_method: '${form.payment_method}',
                    ecocash_number: '${form.ecocash_number}',
                    delivery_method: '${form.delivery_method}',
                    street: '${form.street}',
                    suburb: '${form.suburb}',
                    area: '${form.area}',
                    town: '${form.town}',
                  },
                },
              },
            ],
          },
        ],
      },
    },
  ],
} as const;

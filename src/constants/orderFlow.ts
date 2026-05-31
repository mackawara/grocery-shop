/**
 * WhatsApp Flow JSON for the order capture flow.
 *
 * Structure (modelled after WhatsApp Flow JSON v7.3):
 *   1. ORDER_DETAILS    — name, payment method (+ conditional ecocash number), delivery method.
 *                         The Continue button posts a `data_exchange` to /whatsapp/flows. The
 *                         server reads `delivery_method` and responds with either:
 *                           - { screen: "DELIVERY_ADDRESS", data: {} }  (when delivery)
 *                           - { screen: "SUCCESS", data: {...} }        (when pickup → close flow)
 *
 *   2. DELIVERY_ADDRESS — street, suburb/location, area, town. Footer completes the flow.
 *
 * Conditional rendering:
 *   - ecocash_number is shown (and required) only when payment_method === 'ecocash'
 *     via the `visible` / `required` expressions evaluated client-side.
 */

export const ORDER_FLOW_SCREENS = {
  ORDER_DETAILS: 'ORDER_DETAILS',
  DELIVERY_ADDRESS: 'DELIVERY_ADDRESS',
} as const;

export type OrderFlowScreen =
  (typeof ORDER_FLOW_SCREENS)[keyof typeof ORDER_FLOW_SCREENS];

export const PAYMENT_METHODS = {
  ECOCASH: 'ecocash',
  CASH: 'cash',
  CARD: 'card',
} as const;

export type PaymentMethod =
  (typeof PAYMENT_METHODS)[keyof typeof PAYMENT_METHODS];

export const DELIVERY_METHODS = {
  DELIVERY: 'delivery',
  PICKUP: 'pickup',
} as const;

export type DeliveryMethod =
  (typeof DELIVERY_METHODS)[keyof typeof DELIVERY_METHODS];

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

export const ORDER_FLOW_JSON = {
  version: '7.3',
  data_api_version: '3.0',
  routing_model: {
    [ORDER_FLOW_SCREENS.ORDER_DETAILS]: [ORDER_FLOW_SCREENS.DELIVERY_ADDRESS],
    [ORDER_FLOW_SCREENS.DELIVERY_ADDRESS]: [],
  },
  screens: [
    {
      id: ORDER_FLOW_SCREENS.ORDER_DETAILS,
      title: 'Order Details',
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
          __example__: PAYMENT_METHOD_OPTIONS,
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
          __example__: DELIVERY_METHOD_OPTIONS,
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
                required: "${form.payment_method == 'ecocash'}",
                visible: "${form.payment_method == 'ecocash'}",
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
                type: 'Footer',
                label: 'Continue',
                'on-click-action': {
                  name: 'data_exchange',
                  payload: {
                    full_name: '${form.full_name}',
                    payment_method: '${form.payment_method}',
                    ecocash_number: '${form.ecocash_number}',
                    delivery_method: '${form.delivery_method}',
                  },
                },
              },
            ],
          },
        ],
      },
    },
    {
      id: ORDER_FLOW_SCREENS.DELIVERY_ADDRESS,
      title: 'Delivery Address',
      data: {
        full_name: {
          type: 'string',
          __example__: 'Jane Doe',
        },
        payment_method: {
          type: 'string',
          __example__: PAYMENT_METHODS.ECOCASH,
        },
        ecocash_number: {
          type: 'string',
          __example__: '+263771234567',
        },
      },
      terminal: true,
      layout: {
        type: 'SingleColumnLayout',
        children: [
          {
            type: 'Form',
            name: 'address_form',
            children: [
              {
                type: 'TextSubheading',
                text: 'Where should we deliver?',
              },
              {
                type: 'TextInput',
                name: 'street',
                label: 'Street',
                required: true,
                'input-type': 'text',
                'helper-text': 'House number and street',
              },
              {
                type: 'TextInput',
                name: 'suburb',
                label: 'Suburb / Location',
                required: true,
                'input-type': 'text',
              },
              {
                type: 'TextInput',
                name: 'area',
                label: 'Area',
                required: true,
                'input-type': 'text',
              },
              {
                type: 'TextInput',
                name: 'town',
                label: 'Town / City',
                required: true,
                'input-type': 'text',
              },
              {
                type: 'Footer',
                label: 'Submit order',
                'on-click-action': {
                  name: 'complete',
                  payload: {
                    full_name: '${data.full_name}',
                    payment_method: '${data.payment_method}',
                    ecocash_number: '${data.ecocash_number}',
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

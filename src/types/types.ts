//INCOMING MESSAGE NOTIFICATION PAYLOAD

export interface WebhookNotificationBody {
  object: string;
  entry: Entry[];
}

export interface Entry {
  id: string;
  changes: Changes[];
}

export interface Changes {
  value: Value;
  field: string;
}
export interface Value {
  messaging_product: string;
  metadata: Metadata;
  statuses: Status[];
  contacts: Contact[];
  messages?: MessageNotification[];
}
export interface BaseMessageNotificationPayload {
  from: string;
  id: string;
  timestamp: string;
}
export interface InteractiveMessageNotification
  extends BaseMessageNotificationPayload {
  type: "interactive";
  interactive: InteractivePayLoad;
}
export interface OrderMessageNotification
  extends BaseMessageNotificationPayload {
  type: "order";
  order: Order;
}
export interface ReactionMessageNotification
  extends BaseMessageNotificationPayload {
  type: "reaction";
  reaction: {
    message_id: string; //"MESSAGE_ID",
    emoji: string; //"EMOJI name"
  };
}

export type MessageNotification =
  | InteractiveMessageNotification
  | OrderMessageNotification
  | ReactionMessageNotification
  | Text;
export interface InteractiveListReplyNotifications {
  list_reply: {
    id: string; //unique identifier of the list message eplied to"list_reply_id",
    title: string;
    description: string; //  "list_reply_description"
  };
  type: "list_reply";
}

export interface InteractiveButtonReplyNotification {
  button_reply: {
    id: string; // unique-button-identifier-here,
    title: string; //button-text,
  };
  type: "button_reply";
}

export interface Pricing {
  billable: boolean;
  pricing_model: string;
  category: string;
}
export interface Contact {
  profile: Profile;
  wa_id: string;
  user_id?: string;
}

export interface Text extends BaseMessageNotificationPayload {
  type: "text";
  text: { body: string };
}

export interface Profile {
  name: string;
}
export interface Order {
  catalog_id: string;
  product_items: OrderItems[];
  text: string;
}

export interface BookingItems {
   productName: string;
  quantity: number;
  priceAtOrder: number;
  productRetailerId: string;
  unitPrice: number;
  subtotal:number;
}

export interface WhatsAppOrderProductItem {
  product_retailer_id: string;
  quantity: number;
  item_price?: number;
  currency?: string;
  brand?: string;
  description?: string;
  google_product_category?: string;
}
export interface OrderDeliveryFlowData {
  orderNumber: string;
  orderDate: string;
  itemsList: string;
  totalAmount: string;
  currency: string;
  itemCount: number;
}
export interface OrderItems {
  product_retailer_id: string;
  quantity: string;
  item_price: string;
  currency: string;
}

export interface InteractiveButtonReplyPayload {
  type: "button_reply";
  button_reply: {
    id: string;
    title: string; //Button label text
  };
}
// For incoming messages payload
export type InteractivePayLoad =
  | InteractiveNfmReplyNotification
  | InteractiveButtonReplyNotification
  | InteractiveListReplyNotifications
  | InteractiveButtonReplyPayload;

export interface InteractiveNfmReplyNotification {
  nfm_reply: Nfm_Reply;
  type: "nfm_reply";
}

export type FlowsForm = Enquiry_Feedback_Form | Voucher_Purchase_Form;
export type FlowResponseObject = {
  [key: string]: FlowsForm;
};

export interface Enquiry_Feedback_Form {
  wouldYouRecommend: "yes" | "no";
  site: string;
  feedbackComment: string;
  flow_token: string;
}
export interface Voucher_Purchase_Form {
  location: string;
  voucherType: string;
  payment_method: "ecocash";
  mobile_payment_number: string;
  flow_token: string;
}
export interface Balance_Check_Form {
  location: string;
  voucher: string;
  flow_token: string;
}
export interface Nfm_Reply {
  response_json: string;
  body: "Sent";
  name: "flow";
}
export interface Metadata {
  display_phone_number: string;
  phone_number_id: string;
}

export interface Status {
  id: string;
  status: string;
  timestamp: string;
  recipient_id: string;
  conversation: Conversation;
  pricing: Pricing;
}

export interface Conversation {
  id: string;
  origin: Origin;
}

export interface Origin {
  type: string;
}

export interface Profile {
  name: string;
}

export interface TextObject {
  type: "text";
  text: string;
}

// OUTGOING MESSAGE OBJECTS
//Media Object used in Interactive message object
//https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages#header-object

export type BaseInteractiveObject = {
  body?: { text: string };
  header?: HeaderObject | TextObject; // required for type product list
  footer?: { text: string };
};
export interface ImageHeader {
  type: "image";
  image: { link: string }; // Required when type is "image"
  caption?: string; // Optional, can be used with image type
}

export interface VideoHeader {
  type: "video";
  video: { link: string }; // Required when type is "video"
  caption?: string; // Optional, can be used with video type
}

export interface DocumentHeader {
  type: "document";
  document: { link: string }; // Required when type is "document"
  caption?: string; // Optional, not commonly used with document
}

export interface StickerHeader {
  type: "sticker";
  sticker: { link: string }; // Required when type is "sticker"
}

export interface AudioHeader {
  type: "audio";
  audio: { link: string }; // Required when type is "audio"
}

export interface TextHeader {
  type: "text";
  text: string;
}

export type HeaderObject =
  | ImageHeader
  | VideoHeader
  | DocumentHeader
  | StickerHeader
  | AudioHeader
  | TextHeader;
export interface Actions {
  thumbnail_product_retailer_id?: string;
  flow_token?: string; //TODO: check if required
  flow_action_data?: { navigate_screen: string };
}
export interface TemplateParamButtonObject {
  type: string;
  payload?: string;
  action?: BaseInteractiveActionObject;
}
export interface TemplateParamButton {
  sub_type?: string;
  index?: string;
  parameters: TemplateParamButtonObject[];
}
export interface TemplateComponentParameter {
  type:
    | "text"
    | "action"
    | "button"
    | "currency"
    | "date_time"
    | "image"
    | "header"
    | "body"
    | "footer";
  sub_type?: string;
  index?: string;
  image?: ImageHeader;
  action?: Actions;
  button?: TemplateParamButton;
  parameters?: TemplateParamButton;
  flow_token?: string;
  payload?: string;
  url?: string;
  text?: string;
}
//fir use when sending free form text messages
export interface FreeFormText {
  type: string;
  text: {
    preview_url?: string;
    body: string;
  };
}

export interface TemplateComponentsPostBody {
  type: "header" | "body" | "footer" | "button";
  sub_type?: string;
  index?: string;
  parameters: TemplateComponentParameter[];
}
export interface ReplyButtonObject {
  type: "reply";
  reply: {
    id: string;
    title: string;
  };
}

export interface ReplyButtonPost {
  buttons: ReplyButtonObject[];
}

// Outgoing messages
export type Interactive =
  | InteractiveCTAReply
  | InteractiveFlow
  | InteractiveList
  | InteractiveProductList
  | InteractiveReplyButtonPost
  | CatalogMessage;

export interface InteractiveList extends BaseInteractiveObject {
  type: "list";
  action: {
    sections: InteractiveActionSection[];
    button: string; // this is the button label that will be shown on the button
  };
}
export interface InteractiveProductList extends BaseInteractiveObject {
  type: "product_list";
  action: {
    sections: InteractiveActionSection[];
    button: string; // this is the button label that will be shown on the button
  };
}

export interface CatalogMessage {
  type: "catalog_message";
  body: {
    text: string;
  };
  action: {
    name: "catalog_message";

    /* Parameters object is optional but  preferable if you want to specify the thumbnail to be used */
    parameters?: {
      thumbnail_product_retailer_id?: string;
    };
  };

  /* Footer object is optional */
  footer?: {
    text: string;
  };
}
export interface InteractiveCTAReply extends BaseInteractiveObject {
  type: "cta_url";
  action: {
    name: "cta_url";
    parameters: {
      display_text: string; //Button labe;
      url: string;
    };
  };
}

interface ProductItem {
  product_retailer_id: string; // Required for Multi-Product Messages. Unique ID for the product in the catalog.
}

export interface ActionSectionRows {
  id: string; // Required for List Messages. Unique identifier for the row (max 200 characters).
  title: string; // Required for List Messages. Title of the row (max 24 characters).
  description?: string; // Optional for List Messages. Description of the row (max 72 characters).
}

export interface InteractiveActionSection {
  title: string; // Section title. Required for each section. Max length depends on platform.
  product_items?: ProductItem[]; // Required for Multi-Product Messages. Array of ProductItem objects (1-30 products).
  rows: ActionSectionRows[];
}
export interface InteractiveFlow extends BaseInteractiveObject {
  type: "flow";

  index?: string;
  action: {
    name: "flow";
    parameters: {
      mode?: "draft" | "published"; // Optional for Flows Messages. Default: published.
      flow_message_version: "3"; // Required for Flows Messages. Must be "3".
      flow_token: string; // Unique identifier generated by us .
      flow_id: string; //Unique identifier provided by WhatsApp.
      flow_cta: string; // Required for Flows Messages. CTA button text.
      flow_action?: "navigate" | "data_exchange"; // Default: navigate.
      flow_action_payload?: {
        screen: string; // Required if flow_action is navigate. ID of the first screen.
        data?: Record<string, unknown>; // Optional. Input data for the first screen. Must be a non-empty object.
      };
    };
  };
}
export interface InteractiveReplyButtonPost extends BaseInteractiveObject {
  type: "button";
  action: { buttons: ReplyButtonObject[] };
}
export interface FacebookAPIError {
  response: {
    data: {
      error: {
        message: string;
        fbtrace_id?: string;
        error_data?: {
          details?: string;
        };
      };
    };
  };
}
export interface BaseInteractiveActionObject {
  button?: string; // Required for List Messages. Must be a non-empty string and unique within the message.

  buttons?: ReplyButtonObject[];

  sections?: InteractiveActionSection[];

  catalog_id?: string; // Required for Single-Product and Multi-Product Messages. Unique Facebook catalog ID.
  product_retailer_id?: string; // Required for Single-Product and Multi-Product Messages.
  mode?: "draft" | "published"; // Optional for Flows Messages. Default: published.
  flow_message_version?: "3"; // Required for Flows Messages. Must be "3".
  flow_token?: string; // Required for Flows Messages. Unique identifier generated by the business.
  flow_id?: string; // Required for Flows Messages. Unique identifier provided by WhatsApp.
  flow_cta?: string; // Required for Flows Messages. CTA button text.
  flow_action?: "navigate" | "data_exchange"; // Optional for Flows Messages. Default: navigate.
  flow_action_payload?: {
    screen: string; // Required if flow_action is navigate. ID of the first screen.
    data?: Record<string, unknown>; // Optional. Input data for the first screen. Must be a non-empty object.
  };
}


export interface InteractiveBaseObject {
  header?: {
    type: "text" | "image" | "document" | "video";
    text?: string;
    image?: { link: string };
    document?: { link: string; filename?: string };
    video?: { link: string };
  };
  body: {
    text: string;
  };
  footer?: {
    text: string;
  };
}

export interface InteractiveFlowObject extends InteractiveBaseObject {
  type: "flow";
  action: {
    name: "flow";
    parameters: {
      mode?: "draft" | "published";
      flow_message_version: "3";
      flow_token?: string;
      flow_id: string;
      flow_cta: string;
      flow_action?: "navigate" | "data_exchange";
      flow_action_payload?: {
        screen: string;
        data?: Record<string, unknown>;
      };
    };
  };
}

export interface IVoucher {
  duration: number;
  qos_overwrite?: boolean;
  note?: string;
  code: string;
  for_hotspot?: boolean;
  create_time: number;
  quota: number;
  site_id: string;
  qos_usage_quota?: string;
  _id: string;
  admin_name: string;
  used: 0 | 1;
  status: "VALID_ONE" | "EXPIRED";
  status_expires: number;
}
export interface FLOW_TOKENS {
  saleFlow: string;
}
export const FLOW_TOKENS = {
  saleFlow: "voucher_purchase_flow",
} as const;
export type FlowToken = (typeof FLOW_TOKENS)[keyof typeof FLOW_TOKENS];
export function hasProperty<K extends string>(
  data: unknown,
  prop: K
): data is { [key in K]: unknown } {
  return typeof data === "object" && data !== null && prop in data;
}

export interface FlowRequest {
  currentScreen: string;
  payload: Record<string, unknown>;
  action?: string;
  flow_token?: FlowToken;
}

export type FlowFormData = Enquiry_Feedback_Form | Voucher_Purchase_Form | Balance_Check_Form;
/**
 * Internal response format for flow handling
 * Used for internal flow processing before converting to WhatsApp format
 */
export interface FlowResponse {
  nextScreen: string | null;
  data: FlowFormData | Record<string, unknown>;
  completed?: boolean;
  error?: string;
}

export interface WhatsAppFlowRequest {
  version: string;
  action: string; // "INIT", "data_exchange", "ping", etc.
  screen: string;
  data: Record<string, unknown>;
  flow_token: string;
}

/**
 * Interface for WhatsApp order product item
 */
export interface WhatsAppOrderProductItem {
  product_retailer_id: string;
  quantity: number;
  item_price?: number;
  currency?: string;
}
/**
 * Interface for WhatsApp order payload
 */
export interface WhatsAppOrderPayload {
  catalog_id: string;
  text?: string;
  product_items: WhatsAppOrderProductItem[];
}

/**
 * Interface for the response of the WhatsApp order handler
 */

export interface Item {
  amount: number;
  name: string;
}
export interface PaymentDetails {
  items: Item[];
  phoneNumber: string;
  method: string;
  orderNumber: string;
  
}

export type TCreateService = {
  title: string;
  slug: string;
  lengthInMinutes: number;
};

export type TSlot = {
  time: string;
};

export type TCreateBooking = {
  start: string;
  attendee: {
    name: string;
    email: string;
    timeZone: string;
    phoneNumber: string
  };
  eventTypeId: number;
};

export interface ICalcomSlotsResponse {
  data: {
    slots: {
      [date: string]: TSlot[];
    };
  };
}

export interface ServiceResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}
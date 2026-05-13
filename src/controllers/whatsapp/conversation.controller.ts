import { logger } from "../../services/logger";
import { isMessageProcessed } from "../redis/redis.controller";
import { WA_MESSAGE_TTL_SECONDS } from "../../constants/whatsapp";
import whatsappMessager, { messageComposer } from "./outgoingMessages";
import {
  Text,
  InteractivePayLoad,
  ReactionMessageNotification,
  InteractiveButtonReplyNotification,
  InteractiveListReplyNotifications,
  InteractiveNfmReplyNotification,
} from "../../types/types";
import { MAIN_MENU_REPLY_IDS } from "../../constants/whatsapp";
import {MESSAGES_CONSTRUCTOR} from "./messages";
import { MainMenuSections } from "./messageSections";

const WA_MSG_KEY_PREFIX = "wa:msg:";

export const isWhatsAppMessageProcessed = (messageId: string): Promise<boolean> =>
  isMessageProcessed(`${WA_MSG_KEY_PREFIX}${messageId}`, WA_MESSAGE_TTL_SECONDS);

export const textHandler = async (from: string, text: Text["text"]): Promise<void> => {
  logger.info("[TEXT_MESSAGE] : Processing text message from:", from, "| body:", text.body);
  await whatsappMessager.sendFreeFormTextMessage(from, `Message received: "${text.body}"`);

  await messageComposer.messageWithReplyList({
    text: MESSAGES_CONSTRUCTOR.welcomeMessage,
    listName: "Main Menu",
    sections: MainMenuSections
  }) 
};

const buttonReplyHandler = async (from: string, interactive: InteractiveButtonReplyNotification): Promise<void> => {
  const { button_reply } = interactive;
  logger.info("[INTERACTIVE_BUTTON_REPLY] : from:", from, "| id:", button_reply.id, "| title:", button_reply.title);
  await whatsappMessager.sendFreeFormTextMessage(from, `Button reply received — id: ${button_reply.id}, title: "${button_reply.title}"`);
};

const listReplyHandler = async (from: string, interactive: InteractiveListReplyNotifications): Promise<void> => {
  const { list_reply } = interactive;
  logger.info("[INTERACTIVE_LIST_REPLY] : from:", from, "| id:", list_reply.id, "| title:", list_reply.title);
  await whatsappMessager.sendFreeFormTextMessage(from, `List reply received — id: ${list_reply.id}, title: "${list_reply.title}"`);
  switch (list_reply.id) {
    case MAIN_MENU_REPLY_IDS.shop:
      //TO DO:  Handle shop action
      break;
    case MAIN_MENU_REPLY_IDS.view_deliveries:
      //TO DO: Handle view deliveries action
      break;
    case MAIN_MENU_REPLY_IDS.enquries:
      //TO DO: Handle enquiries action
      break;
  }
};

const nfmReplyHandler = async (from: string, interactive: InteractiveNfmReplyNotification): Promise<void> => {
  const { nfm_reply } = interactive;
  logger.info("[INTERACTIVE_NFM_REPLY] : from:", from, "| name:", nfm_reply.name, "| response:", nfm_reply.response_json);
  await whatsappMessager.sendFreeFormTextMessage(from, `Flow response received — form: "${nfm_reply.name}"`);
};

export const interactiveHandler = async (from: string, interactive: InteractivePayLoad): Promise<void> => {
  switch (interactive.type) {
    case "button_reply":
      await buttonReplyHandler(from, interactive);
      break;
    case "list_reply":
      await listReplyHandler(from, interactive);
      break;
    case "nfm_reply":
      await nfmReplyHandler(from, interactive);
      break;
    default:
      logger.info("[INTERACTIVE_MESSAGE] : Unhandled interactive type from:", from);
  }
};

export const reactionHandler = async (from: string, reaction: ReactionMessageNotification["reaction"]): Promise<void> => {
  logger.info("[REACTION_MESSAGE] : from:", from, "| emoji:", reaction.emoji, "| on message:", reaction.message_id);
  await whatsappMessager.sendFreeFormTextMessage(from, `Reaction received — emoji: ${reaction.emoji}`);
};

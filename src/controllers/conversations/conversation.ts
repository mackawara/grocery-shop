import { logger } from "../../services/logger";

const buttonReplyHandler = async (clientNumber: string, replyId: string) => {
  const TAG = "[REPLY-BUTTON-MESSAGE]"
  try {
    logger.info( `${TAG} Received a button reply message`);
  } catch (error) {
    logger.error("Error on button reply handler", error);
  }
  return;
};

const listReplyHandler = async (clientNumber: string, replyId: string) => {
  const TAG = "[REPLY-LIST-MESSAGE]"
  try {
     logger.info(`${TAG} Received a list reply message`, replyId)
  } catch (error) {
    logger.error("Error on list reply handler", error);
    throw error;
  }
};

const textReplyHandler = async (clientNumber: string, text: string) => {
  const TAG = "[TEXT MESSAGE]"
  try {
   logger.info(`${TAG} Received Text Reply Message`);
  } catch (error) {
    logger.error(`${TAG} Error on text reply message `, error);
    throw error;
  }
};

const interactiveReplyHandler = async (
  clientNumber: string,
  interactive: "InteractivePayLoad",//replace with actual type
) => {
  const interactiveType = interactive.type;
  const TAG = "[INTERACTIVE MESSAGE]"
  try {
    logger.info(`${TAG} Received interactive Reply Message`);
    switch (interactiveType) {
      case "button_reply":
        {
          await buttonReplyHandler(clientNumber, interactive.button_reply.id);
        }
        break;
      case "list_reply": {
        const listReply = interactive.list_reply.id;
        logger.info(`list reply message with ID ${listReply}`);
        await listReplyHandler(clientNumber, listReply);
        break;
      }
      default:
        break;
    }

    return;
  } catch (error) {
    logger.error(
      `${TAG} Error on interactive reply message `,
      error,
    );
    throw error;
  }
};

const CONVERSATION_CONTROLLER = {
  buttonReplyHandler,
  listReplyHandler,
  interactiveReplyHandler,
  textReplyHandler,
};

export default CONVERSATION_CONTROLLER;

import { logger } from "../../services/logger";
import { Order } from "../../types/types";
import whatsappMessager from "./outgoingMessages";

export const orderHandler = async (from: string, order: Order): Promise<void> => {
  logger.info("[ORDER_MESSAGE] : Processing catalog order from:", from, "| catalog:", order.catalog_id, "| items:", order.product_items.length);
  await whatsappMessager.sendFreeFormTextMessage(from, `Order received — ${order.product_items.length} item(s) from catalog ${order.catalog_id}`);
};

import { logger } from '../../services/logger.ts';
import whatsappMessager from '../whatsapp/outgoingMessages.ts';
import OrderModel from '../../models/Order.ts';
import DeliveryAddressModel from '../../models/DeliveryAddress.ts';
import Tenant from '../../models/Tenant.ts';
import { getTenantId } from '../../context/tenantContext.ts';
import { getRedisHashValue, setRedisHashKeyValuePair } from '../redis/redis.controller.ts';
import { quoteAndConfirmDelivery } from './deliveryQuote.controller.ts';

const TAG = '[DELIVERY_FLOW]';

const ADDRESS_SESSION_TTL_SECONDS = 1800;

const STATE_KEY = 'addressFlowState';

export const ADDRESS_STATE = {
  AWAITING_LOCATION: 'awaiting_location',
} as const;

/**
 * Send the location_request_message asking the customer to drop a GPS pin.
 * Called by orderFlowHandler once the DeliveryAddress
 *  (typed fields) is saved.
 */
export const promptForLocation = async (from: string): Promise<void> => {
  try {
    const result = await whatsappMessager.sendLocationRequestMessage(
      from,

      'Thanks! 📍 Please share your delivery location pin so our driver can find you. Tap the attachment icon → Location → Send your current location.',
    );
    if (result.success) {
      await setRedisHashKeyValuePair({
        hashName: from,
        key: STATE_KEY,
        value: ADDRESS_STATE.AWAITING_LOCATION,
        expiry: ADDRESS_SESSION_TTL_SECONDS,
      });
    } else {
      logger.error(`${TAG} Failed to send location request message to ${from}: ${result.error}`);
    }
  } catch (error) {
    // Re-throw so orderFlowHandler's catch shows the user an apology message.
    logger.error(`${TAG} Error prompting ${from} for location: ${error}`);
    throw error;
  }
};

/**
 * Inbound 'location' message: update `location_gps` on the DeliveryAddress
 * already created by the order flow. Nothing else is touched — Order only
 * holds the FK, and address field writes are the order flow's job.
 *
 * Idempotent: a second pin within the TTL window simply overwrites the GPS.
 */
export const handleDeliveryLocation = async (
  from: string,
  location: {
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
  },
): Promise<void> => {
  try {
    const state = await getRedisHashValue(from, STATE_KEY);
    if (state !== ADDRESS_STATE.AWAITING_LOCATION) {
      logger.info(`${TAG} Ignoring location from ${from} — not awaiting location (state=${state})`);
      return;
    }

    const orderNumber = await getRedisHashValue(from, 'orderNumber');
    if (!orderNumber) {
      logger.warn(`${TAG} No active order for ${from} when location arrived`);
      return;
    }

    const order = await OrderModel.findOne({ orderNumber })
      .select('deliveryDetails.address')
      .lean();
    if (!order) {
      logger.warn(`${TAG} Order ${orderNumber} not found for ${from}`);
      return;
    }

    const addressId = order.deliveryDetails?.address;
    if (!addressId) {
      logger.warn(`${TAG} Order ${orderNumber} has no address ref — typed address never saved?`);
      return;
    }

    const gps = {
      latitude: location.latitude,
      longitude: location.longitude,
      ...(location.name ? { name: location.name } : {}),
      ...(location.address ? { address: location.address } : {}),
    };

    await DeliveryAddressModel.updateOne({ _id: addressId }, { $set: { location_gps: gps } });

    // Intentionally leave STATE_KEY in place — its TTL acts as the "you can
    // still correct the pin" window (~30 min).

    await whatsappMessager.sendFreeFormTextMessage(
      from,

      `Got it! We've saved your delivery location for order ${orderNumber}.\n\nWrong location? Just send a new pin to update it.`,
    );

    // Address is fully sorted (typed fields + GPS) — price the delivery and
    // ask the customer to confirm the new total. Payment is initiated by the
    // quote flow (after the confirm tap), not here.
    const tenant = await Tenant.findById(getTenantId()).select('location_gps').lean();
    const shopOrigin =
      tenant?.location_gps?.latitude != null && tenant?.location_gps?.longitude != null
        ? { latitude: tenant.location_gps.latitude, longitude: tenant.location_gps.longitude }
        : undefined;
    await quoteAndConfirmDelivery(from, orderNumber, shopOrigin, gps);
  } catch (error) {
    logger.error(`${TAG} Error handling delivery location from ${from}: ${error}`);

    await setRedisHashKeyValuePair({
      hashName: from,
      key: STATE_KEY,
      value: ADDRESS_STATE.AWAITING_LOCATION,
      expiry: ADDRESS_SESSION_TTL_SECONDS,
    }).catch((stateError) => {
      logger.error(`${TAG} Failed to reset location state for ${from}: ${stateError}`);
    });

    await whatsappMessager
      .sendFreeFormTextMessage(
        from,
        'Sorry, we had trouble saving your location. Please send your pin again.',
      )
      .catch((sendError) => {
        logger.error(`${TAG} Failed to notify ${from} of location error: ${sendError}`);
      });
  }
};

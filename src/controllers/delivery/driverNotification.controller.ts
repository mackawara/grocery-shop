import { logger } from '../../services/logger.ts';
import { CONFIG } from '../../config.ts';
import whatsappMessager from '../whatsapp/outgoingMessages.ts';
import DeliveryAddressModel from '../../models/DeliveryAddress.ts';
import type { IOrder } from '../../models/Order.ts';
import type { IDelivery } from '../../delivery/index.ts';
import { PAYMENT_METHOD_LABELS } from '../../constants/models.ts';
import type { PaymentMethod } from '../../constants/models.ts';
import { ORDER_CURRENCY } from '../../constants/payments.ts';

const TAG = '[DRIVER_NOTIFY]';

// A driver is a member of staff, not a customer: they have no open 24-hour
// customer-care window with the shop's number, so the only way to reach them is
// a pre-approved template. The template is configured, not hardcoded, because
// each vendor registers it on their own WABA — and until one is approved the
// name is blank and this whole path stays dormant rather than firing sends that
// Meta will reject.
//
// Expected template body (5 positional parameters, in this order):
//   1 order number   2 customer name   3 delivery address
//   4 order total    5 payment method
// See deploy/README.md → Driver assignment template.
const PARAM_COUNT = 5;

// Meta rejects template parameters containing newlines, tabs, or four or more
// consecutive spaces, and caps their length — so every value is flattened to a
// single clean line before it goes near the API.
const MAX_PARAM_LENGTH = 200;
const templateParam = (value: string | undefined, fallback: string): string => {
  const flat = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) {
    return fallback;
  }
  return flat.length > MAX_PARAM_LENGTH ? `${flat.slice(0, MAX_PARAM_LENGTH - 1)}…` : flat;
};

// The address as one line the driver can read at a glance. The GPS pin is the
// thing that actually gets them to the door, but it can't ride in a text
// parameter — the dashboard order view is where they open the map.
const formatAddress = async (addressId: unknown): Promise<string> => {
  if (!addressId) {
    return '';
  }
  const address = await DeliveryAddressModel.findById(String(addressId))
    .select('streetNumber streetName area subArea city')
    .lean();
  if (!address) {
    return '';
  }
  return [
    [address.streetNumber, address.streetName].filter(Boolean).join(' '),
    address.subArea,
    address.area,
    address.city,
  ]
    .filter((part) => Boolean(part && String(part).trim()))
    .join(', ');
};

/**
 * Tell a driver, on WhatsApp, that an order has been assigned to them.
 *
 * Best-effort by contract: the assignment is already persisted when this runs,
 * and a failed or unconfigured notification must never undo it or fail the
 * request. Every outcome is logged so a silently unreachable driver is
 * visible in the logs rather than invisible.
 *
 * Must run inside the tenant context.
 */
export const notifyDriverOfAssignment = async (
  order: IOrder,
  delivery: IDelivery,
  driver: { phoneNumber: string; name: string },
): Promise<void> => {
  const templateName = CONFIG.WHATSAPP_DRIVER_ASSIGNMENT_TEMPLATE;
  if (!templateName) {
    logger.info(
      `${TAG} no driver-assignment template configured — not notifying ${driver.name} ` +
        `about order ${order.orderNumber}`,
    );
    return;
  }

  try {
    const address = await formatAddress(delivery.address);
    const method = order.paymentDetails?.method as PaymentMethod | undefined;

    const parameters = [
      templateParam(order.orderNumber, order.orderNumber),
      templateParam(order.customerName, 'Customer'),
      templateParam(address, 'See dashboard for address'),
      templateParam(`${ORDER_CURRENCY} ${order.totalAmount.toFixed(2)}`, ORDER_CURRENCY),
      templateParam(method ? PAYMENT_METHOD_LABELS[method] : undefined, 'Not set'),
    ].map((text) => ({ type: 'text' as const, text }));

    if (parameters.length !== PARAM_COUNT) {
      // Guards the template contract: a mismatch is a 132000 rejection from
      // Meta, which is far harder to read than this line.
      logger.error(`${TAG} built ${parameters.length} parameters, template expects ${PARAM_COUNT}`);
      return;
    }

    const result = await whatsappMessager.sendTemplate({
      to: driver.phoneNumber,
      name: templateName,
      languageCode: CONFIG.WHATSAPP_DRIVER_ASSIGNMENT_TEMPLATE_LANG,
      components: [{ type: 'body', parameters }],
    });

    if (result.success) {
      logger.info(`${TAG} notified driver about order ${order.orderNumber}`);
    } else {
      logger.error(
        `${TAG} could not notify driver about order ${order.orderNumber}: ${result.error}`,
      );
    }
  } catch (err) {
    logger.error(
      `${TAG} driver notification threw for order ${order.orderNumber}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
};

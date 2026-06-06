import mongoose from 'mongoose';
import type { Types } from 'mongoose';
import { logger } from '../../services/logger';
import { CONFIG } from '../../config';
import OrderModel from '../../models/Order';
import PaymentModel from '../../models/Payment';
import Tenant from '../../models/Tenant';
import {
  PaymentProvider,
  PaymentStatus,
  OrderStatus,
  resolvePaymentProvider,
} from '../../constants/models';
import type { PaymentMethod } from '../../constants/models';
import {
  getTenantId,
  runWithTenant,
  runWithoutTenant,
} from '../../context/tenantContext';
import whatsappMessager, { messageComposer } from '../whatsapp/outgoingMessages';
import { normaliseZimMobile } from '../../utils/sanitize';
import { buildPaymentRetryButtonId } from '../../constants/payments';
import { getProviderAdapter } from './providers/registry';
import { parsePaynowStatusUpdate } from './gateways/paynowClient';
import type {
  InitiatePaymentInput,
  PaymentProviderContext,
} from './providers/types';

const TAG = '[PAYMENT]';

const DEFAULT_CURRENCY = 'USD';

// The tenant slug in the path lets the webhook re-establish scope, no shared secret.
const buildCallbackUrls = (tenantSlug: string): { resultUrl: string; returnUrl: string } => {
  const base = CONFIG.PUBLIC_BASE_URL.replace(/\/+$/, '');
  return {
    resultUrl: `${base}/payments/paynow/webhook/${tenantSlug}`,
    returnUrl: `${base}/payments/paynow/return`,
  };
};

// Order number rides in the button id so the reply handler can re-charge it.
const sendPaymentRetryPrompt = async (
  from: string,
  orderNumber: string,
  reason?: string,
): Promise<void> => {
  await whatsappMessager.sendInteractive(
    from,
    messageComposer.messageWithReplyButtons({
      // eslint-disable-next-line max-len
      text: `We couldn't complete payment for order ${orderNumber}${reason ? `: ${reason}` : ''}. Would you like to try again?`,
      buttons: [
        { type: 'reply', reply: { id: buildPaymentRetryButtonId(orderNumber), title: 'Try again' } },
      ],
    }),
  );
};

/**
 * Charges an order once delivery/collection is sorted. Mobile-money settlement
 * arrives later via webhook. Must run inside an active tenant context.
 */
export const initiateOrderPayment = async (
  from: string,
  orderNumber: string,
): Promise<void> => {
  logger.info(`${TAG} Initiating payment for order ${orderNumber} (${from})`);

  const order = await OrderModel.findOne({ orderNumber });
  if (!order) {
    logger.warn(`${TAG} Order ${orderNumber} not found`);
    await whatsappMessager.sendFreeFormTextMessage(from, 'Sorry, we could not find your order to process payment.');
    return;
  }

  // Double-charge guard: only a prior failed attempt may retry. Matters because
  // a corrected delivery pin re-enters this path. Reused for the attempt count.
  const priorPayments = await PaymentModel.find({ orderNumber }).select('status').lean();
  const inFlight = priorPayments.find(
    (p) => p.status === PaymentStatus.PENDING || p.status === PaymentStatus.PAID,
  );
  if (inFlight) {
    logger.info(`${TAG} Order ${orderNumber} already has a ${inFlight.status} payment — skipping re-initiation`);
    return;
  }

  const method = order.paymentDetails?.method as PaymentMethod | undefined;
  if (!method) {
    logger.warn(`${TAG} Order ${orderNumber} has no payment method set`);
    await whatsappMessager.sendFreeFormTextMessage(from, 'We could not determine your payment method. Please restart your order.');
    return;
  }

  // credentials are select:false, so pull them explicitly.
  const tenant = await Tenant.findById(getTenantId()).select('+paymentCredentials paymentRouting slug');
  if (!tenant) {
    logger.error(`${TAG} Tenant ${getTenantId()} not found while paying order ${orderNumber}`);
    await whatsappMessager.sendFreeFormTextMessage(from, 'Sorry, we hit a configuration issue. Please try again shortly.');
    return;
  }

  const provider = resolvePaymentProvider(method, tenant.paymentRouting);
  const attempts = priorPayments.length + 1;

  // Cash on delivery: no gateway. Confirm the order and leave a PENDING payment
  // row for staff to settle later. The two writes must land together, else a
  // confirmed order with no payment row would corrupt reconciliation.
  if (provider === PaymentProvider.CASH_ON_DELIVERY) {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      await PaymentModel.create(
        [{
          order: order._id as Types.ObjectId,
          orderNumber,
          provider,
          method,
          amount: order.totalAmount,
          currency: DEFAULT_CURRENCY,
          status: PaymentStatus.PENDING,
          whatsappFrom: from,
          attempts,
        }],
        { session },
      );
      order.status = OrderStatus.CONFIRMED;
      order.paymentDetails.status = PaymentStatus.PENDING;
      await order.save({ session });
      await session.commitTransaction();
    } catch (error) {
      await session.abortTransaction();
      logger.error(`${TAG} COD confirmation failed for ${orderNumber}: ${error instanceof Error ? error.message : String(error)}`);
      await whatsappMessager.sendFreeFormTextMessage(from, 'Sorry, we hit an issue confirming your order. Please try again.');
      return;
    } finally {
      session.endSession();
    }
    logger.info(`${TAG} Order ${orderNumber} confirmed for cash on delivery — payment PENDING ${DEFAULT_CURRENCY} ${order.totalAmount.toFixed(2)}, settle manually`);
    await whatsappMessager.sendFreeFormTextMessage(
      from,
      // eslint-disable-next-line max-len
      `Your order ${orderNumber} is confirmed! Please have ${DEFAULT_CURRENCY} ${order.totalAmount.toFixed(2)} ready to pay on delivery.`,
    );
    return;
  }

  const adapter = getProviderAdapter(provider);
  if (!adapter) {
    // Routed to a gateway we haven't built yet (standalone EcoCash/OMari).
    logger.warn(`${TAG} No adapter for provider ${provider} (order ${orderNumber})`);
    await sendPaymentRetryPrompt(from, orderNumber, 'that payment method is not available yet');
    return;
  }

  const payerMobileNumber =
    order.paymentDetails.mobileNumber;

  const input: InitiatePaymentInput = {
    orderNumber,
    amount: order.totalAmount,
    currency: DEFAULT_CURRENCY,
    description: `Order ${orderNumber}`,
    method,
    payerMobileNumber,
  };

  const context: PaymentProviderContext = {
    credentials: tenant.paymentCredentials,
    ...buildCallbackUrls(tenant.slug),
  };

  // Record up front so a gateway failure still leaves an audit row.
  const payment = await PaymentModel.create({
    order: order._id as Types.ObjectId,
    orderNumber,
    provider,
    method,
    amount: order.totalAmount,
    currency: DEFAULT_CURRENCY,
    status: PaymentStatus.PENDING,
    payerMobileNumber,
    whatsappFrom: from,
    attempts,
  });

  const result = await adapter.initiate(input, context);

  // The payment status and the order's mirror of it must land together, else a
  // PENDING gateway push could leave the order out of sync with reconciliation.
  payment.status = result.status;
  payment.providerReference = result.providerReference;
  payment.instructions = result.instructions;
  payment.lastError = result.error;
  if (result.success) {
    // method was already set by the order flow.
    order.paymentDetails.status = result.status;
    order.paymentDetails.reference = result.providerReference;
  } else {
    order.paymentDetails.status = PaymentStatus.FAILED;
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    await payment.save({ session });
    await order.save({ session });
    await session.commitTransaction();
  } catch (error) {

    await session.abortTransaction();
    logger.error(`${TAG} Failed to persist payment result for ${orderNumber}: ${error instanceof Error ? error.message : String(error)}`);
    await PaymentModel.updateOne({ _id: payment._id }, { status: PaymentStatus.FAILED }).catch(() => {});
    await whatsappMessager.sendFreeFormTextMessage(from, 'Sorry, we hit an issue processing your payment. Please try again.');
    return;
  } finally {
    session.endSession();
  }

  if (!result.success) {
    logger.warn(`${TAG} Payment FAILED to start for order ${orderNumber} via ${provider}: ${result.error}`);
    await sendPaymentRetryPrompt(from, orderNumber, result.error);
    return;
  }

  logger.info(`${TAG} Payment PENDING for order ${orderNumber} via ${provider} (${DEFAULT_CURRENCY} ${order.totalAmount.toFixed(2)}) — push sent, awaiting customer approval`);
  await whatsappMessager.sendFreeFormTextMessage(
    from,
    `Payment request sent for order ${orderNumber}. Please approve the prompt on your phone.`,
  );
};

/**
 * Settles a Paynow callback (resultUrl). Re-establishes tenant scope from the
 * slug, then verifies the hash (SDK throws on mismatch → fail closed). `rawBody`
 * must be the untouched request body so the SDK can recompute the hash.
 */
export const isPaynowWebhookAccepted = async (
  tenantSlug: string,
  rawBody: string,
): Promise<boolean> => {
  // Resolve the tenant unscoped; writes below run inside its context.
  const tenant = await runWithoutTenant(
    'paynow webhook tenant resolution',
    `Tenant.findOne({ slug: ${tenantSlug} })`,
    () => Tenant.findOne({ slug: tenantSlug }).select('+paymentCredentials slug _id'),
  );
  if (!tenant) {
    logger.warn(`${TAG} Paynow webhook for unknown tenant slug=${tenantSlug}`);
    return false;
  }

  const credentials = tenant.paymentCredentials?.paynow;
  if (!credentials) {
    logger.warn(`${TAG} Paynow webhook for tenant=${tenantSlug} without Paynow credentials`);
    return false;
  }

  let reference: string | undefined;
  let pollUrl: string | undefined;
  let status: PaymentStatus;
  let rawStatus: string | undefined;
  try {
    const update = parsePaynowStatusUpdate(rawBody, credentials.integrationId, credentials.integrationKey);
    reference = update.reference;
    pollUrl = update.pollUrl;
    status = update.status;
    rawStatus = update.rawStatus;
  } catch (error) {
    logger.error(`${TAG} Paynow webhook verification failed for tenant=${tenantSlug}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  if (!reference) {
    logger.warn(`${TAG} Paynow webhook missing reference for tenant=${tenantSlug}`);
    return false;
  }
  const orderNumber = reference;
  logger.info(`${TAG} Paynow callback for order ${orderNumber}: status=${status} (paynow="${rawStatus}")`);

  return runWithTenant(tenant._id as Types.ObjectId, async () => {
    // Match the exact attempt by its poll URL (stored as providerReference);
    // ordering by createdAt alone settles the wrong record once an order has
    // retried. Fall back to the latest attempt only if Paynow omits the URL.
    const payment = pollUrl
      ? await PaymentModel.findOne({ orderNumber, providerReference: pollUrl })
      : await PaymentModel.findOne({ orderNumber }).sort({ createdAt: -1 });
    if (!payment) {
      logger.warn(`${TAG} Paynow webhook: no payment for order ${orderNumber}${pollUrl ? ` (pollUrl=${pollUrl})` : ''}`);
      return false;
    }

    // Idempotent: ignore repeats once we've already settled this attempt.
    if (payment.status === status) {
      logger.info(`${TAG} Paynow webhook: order ${orderNumber} already ${status}, ignoring repeat`);
      return true;
    }

    payment.status = status;
    if (status === PaymentStatus.PAID) {
      payment.paidAt = new Date();
    }

    // Settle the payment and its order in one transaction so a failure mid-update
    // can't leave the payment marked PAID while the order stays unconfirmed.
    const session = await mongoose.startSession();
    session.startTransaction();
    let order;
    try {
      order = await OrderModel.findOne({ orderNumber }).session(session);
      if (order) {
        order.paymentDetails.status = status;
        if (status === PaymentStatus.PAID) {
          order.status = OrderStatus.CONFIRMED;
        }
        await order.save({ session });
      }
      await payment.save({ session });
      await session.commitTransaction();
    } catch (error) {
      await session.abortTransaction();
      const reason = error instanceof Error ? error.message : String(error);
      logger.error(`${TAG} Failed to settle order ${orderNumber}: ${reason}`);
      return false;
    } finally {
      session.endSession();
    }

    // Notify only after the commit succeeds — an aborted write must not send messages.
    if (order) {
      // The WhatsApp sender id — not the mobile-money number, which isn't a recipient.
      const from = payment.whatsappFrom;
      if (from) {
        if (status === PaymentStatus.PAID) {
          await whatsappMessager.sendFreeFormTextMessage(
            from,
            `Payment received for order ${orderNumber} — thank you! We'll be in touch shortly. 🎉`,
          );
        } else if (status === PaymentStatus.FAILED) {
          await sendPaymentRetryPrompt(from, orderNumber);
        }
      }
    }

    if (status === PaymentStatus.PAID) {
      logger.info(`${TAG} Payment PAID for order ${orderNumber} (${payment.currency} ${payment.amount})`);
    } else if (rawStatus === 'cancelled') {
      logger.warn(`${TAG} Payment CANCELLED by customer for order ${orderNumber}`);
    } else if (status === PaymentStatus.FAILED) {
      logger.warn(`${TAG} Payment FAILED for order ${orderNumber} (paynow="${rawStatus}")`);
    } else {
      logger.info(`${TAG} Payment for order ${orderNumber} now ${status} (paynow="${rawStatus}")`);
    }
    return true;
  }, tenant.slug);
};

import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { isValidObjectId } from 'mongoose';
import { Paynow } from 'paynow';
import { z } from 'zod';
import { CONFIG } from '../config.ts';
import { runWithTenant } from '../context/tenantContext.ts';
import { Invoice, PaymentAttempt } from './models.ts';
import { BillingError, invoiceBalance, lockAccount, transaction } from './service.ts';
import { billingHandler } from './controller.ts';
import { money } from './math.ts';
import { settleVerifiedPayment } from './settlement.ts';
import { Currency } from '../constants/models.ts';
import { verifiedBillingUpdate } from './paynowSignature.ts';

const platformPaynow = (): Paynow => {
  if (
    !CONFIG.BILLING_PAYNOW_INTEGRATION_ID ||
    !CONFIG.BILLING_PAYNOW_INTEGRATION_KEY ||
    !CONFIG.BILLING_PAYNOW_AUTH_EMAIL
  ) {
    throw new BillingError('Platform billing payments are not configured', 503);
  }
  const paynow = new Paynow(
    CONFIG.BILLING_PAYNOW_INTEGRATION_ID,
    CONFIG.BILLING_PAYNOW_INTEGRATION_KEY,
  );
  paynow.returnUrl = `${CONFIG.DASHBOARD_URL}/billing`;
  return paynow;
};
export const payInvoice = billingHandler(async (req, res) => {
  const id = String(req.params.id);
  if (!isValidObjectId(id)) {
    throw new BillingError('Invalid invoice id', 400);
  }
  const input = z
    .object({
      phone: z.string().regex(/^2637\d{8}$/, 'Use a Zimbabwe mobile number starting 2637'),
      method: z.enum(['ecocash', 'omari']),
    })
    .strict()
    .parse(req.body);
  const paynow = platformPaynow();
  const attempt = await transaction(async (session) => {
    await lockAccount(session);
    const invoice = await Invoice.findById(id).session(session);
    if (!invoice) {
      throw new BillingError('Invoice not found', 404);
    }
    if (invoice.currency !== Currency.USD) {
      throw new BillingError('Only USD payments are supported');
    }
    const balance = await invoiceBalance(invoice, session);
    if (balance === 0) {
      throw new BillingError('Invoice is already settled');
    }
    const pending = await PaymentAttempt.findOne({
      invoiceId: invoice._id,
      status: { $in: ['initiating', 'pending'] },
    }).session(session);
    if (pending) {
      throw new BillingError(
        'A payment is already pending; approve it on your phone or wait for its final status',
      );
    }
    const [created] = await PaymentAttempt.create(
      [
        {
          invoiceId: invoice._id,
          amount: money(balance),
          reference: `billing-${randomUUID()}`,
          status: 'initiating',
        },
      ],
      { session },
    );
    return created;
  });
  paynow.resultUrl = `${CONFIG.PUBLIC_BASE_URL}/billing/paynow/webhook/${String(attempt.tenantId)}`;
  const payment = paynow.createPayment(attempt.reference, CONFIG.BILLING_PAYNOW_AUTH_EMAIL);
  payment.add(`Platform invoice ${id}`, attempt.amount.amount / 100);
  let response;
  try {
    response = await paynow.sendMobile(payment, input.phone, input.method);
  } catch {
    // Ambiguous transport failure: a push may already have been sent. Keep the
    // attempt locked until a signed callback (or admin/provider investigation).
    throw new BillingError(
      'Paynow did not confirm the request. Check your phone before trying again',
      502,
    );
  }
  if (!response.success) {
    await PaymentAttempt.updateOne(
      { _id: attempt._id, status: 'initiating' },
      { $set: { status: 'failed' } },
    );
    throw new BillingError('Paynow could not initiate the payment. Please try again', 502);
  }
  if (!response.pollUrl) {
    throw new BillingError('Paynow did not return payment confirmation details', 502);
  }
  // A callback can win the race with this write; never regress paid to pending.
  await PaymentAttempt.updateOne(
    { _id: attempt._id, status: 'initiating' },
    { $set: { status: 'pending', pollUrl: response.pollUrl, instructions: response.instructions } },
  );
  res.json({
    message: response.instructions ?? 'Approve the payment on your phone',
    reference: attempt.reference,
  });
});

export const paymentWebhook = async (req: Request, res: Response): Promise<void> => {
  const tenantId = String(req.params.tenantId);
  if (!isValidObjectId(tenantId) || typeof req.body !== 'string') {
    res.status(400).send('error');
    return;
  }
  platformPaynow();
  let update;
  try {
    update = verifiedBillingUpdate(
      req.body,
      CONFIG.BILLING_PAYNOW_INTEGRATION_ID,
      CONFIG.BILLING_PAYNOW_INTEGRATION_KEY,
    );
  } catch {
    res.status(400).send('error');
    return;
  }
  const accepted = await runWithTenant(tenantId, () =>
    transaction(async (session) => settleVerifiedPayment(update, session)),
  );
  res.status(accepted ? 200 : 400).send(accepted ? 'ok' : 'error');
};

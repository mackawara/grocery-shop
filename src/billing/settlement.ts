import type { ClientSession } from 'mongoose';
import { Currency } from '../constants/models.ts';
import { CreditNote, Invoice, PaymentAttempt, Receipt } from './models.ts';
import { audit, invoiceBalance, lockAccount } from './service.ts';
import { money } from './math.ts';

export interface VerifiedPayment {
  reference: string;
  status: string;
  amountMinor: number;
  pollUrl?: string;
}
export const settleVerifiedPayment = async (
  update: VerifiedPayment,
  session: ClientSession,
): Promise<boolean> => {
  const amount = update.amountMinor;
  await lockAccount(session);
  const attempt = await PaymentAttempt.findOne({ reference: update.reference })
    .select('+pollUrl')
    .session(session);
  if (
    !attempt ||
    attempt.amount.amount !== amount ||
    (attempt.pollUrl && attempt.pollUrl !== update.pollUrl)
  ) {
    return false;
  }
  const status = update.status.toLowerCase();
  if (['paid', 'awaiting delivery', 'delivered'].includes(status)) {
    if (attempt.status === 'refunded') {
      return true;
    }
    if (!(await Receipt.exists({ key: `paid:${String(attempt._id)}` }).session(session))) {
      const invoice = await Invoice.findById(attempt.invoiceId).session(session);
      if (!invoice) {
        return false;
      }
      const excess = Math.max(0, attempt.amount.amount - (await invoiceBalance(invoice, session)));
      await Receipt.create(
        [
          {
            invoiceId: attempt.invoiceId,
            attemptId: attempt._id,
            key: `paid:${String(attempt._id)}`,
            amount: attempt.amount,
            paidAt: new Date(),
          },
        ],
        { session },
      );
      if (excess > 0) {
        const reason = 'Payment exceeded the outstanding invoice balance; credit carried forward';
        await CreditNote.create(
          [
            {
              key: `overpayment:${String(attempt._id)}`,
              invoiceId: attempt.invoiceId,
              currency: Currency.USD,
              amount: money(excess),
              appliedToSource: money(0),
              kind: 'overpayment',
              actor: 'system',
              reason,
            },
          ],
          { session },
        );
        await audit(
          'system',
          'overpayment_credit',
          reason,
          { attemptId: attempt._id, amount: money(excess) },
          session,
        );
      }
    }
    attempt.status = 'paid';
  } else if (status === 'refunded') {
    const paid = await Receipt.exists({ key: `paid:${String(attempt._id)}` }).session(session);
    if (!paid) {
      return false;
    }
    if (!(await Receipt.exists({ key: `refund:${String(attempt._id)}` }).session(session))) {
      await Receipt.create(
        [
          {
            invoiceId: attempt.invoiceId,
            attemptId: attempt._id,
            key: `refund:${String(attempt._id)}`,
            amount: money(-attempt.amount.amount),
            paidAt: new Date(),
          },
        ],
        { session },
      );
      const overpayment = await CreditNote.findOne({
        key: `overpayment:${String(attempt._id)}`,
      }).session(session);
      if (overpayment) {
        const reason = 'Platform payment refunded; its overpayment credit is reversed';
        await CreditNote.create(
          [
            {
              key: `refund-overpayment:${String(attempt._id)}`,
              invoiceId: attempt.invoiceId,
              currency: Currency.USD,
              amount: money(-overpayment.amount.amount),
              appliedToSource: money(0),
              kind: 'adjustment',
              actor: 'system',
              reason,
            },
          ],
          { session },
        );
        await audit(
          'system',
          'refund_credit_adjustment',
          reason,
          { attemptId: attempt._id },
          session,
        );
      }
    }
    attempt.status = 'refunded';
  } else if (['failed', 'cancelled', 'disputed'].includes(status)) {
    if (attempt.status !== 'paid' && attempt.status !== 'refunded') {
      attempt.status = 'failed';
    }
  }
  if (!attempt.pollUrl && update.pollUrl) {
    attempt.pollUrl = update.pollUrl;
  }
  await attempt.save({ session });
  return true;
};

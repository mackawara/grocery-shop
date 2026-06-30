import { Paynow } from 'paynow';
import { PaymentStatus } from '../../../constants/models.ts';
import { logger } from '../../../services/logger.ts';

const TAG = '[PAYNOW_CLIENT]';

// Collapse Paynow's granular states into the three we track.
const mapStatus = (raw?: string): PaymentStatus => {
  switch (raw?.toLowerCase()) {
    case 'paid':
    case 'awaiting delivery':
    case 'delivered':
      return PaymentStatus.PAID;
    case 'cancelled':
    case 'failed':
    case 'disputed':
      return PaymentStatus.FAILED;
    case 'refunded':
      return PaymentStatus.REFUNDED;
    default:
      return PaymentStatus.PENDING; // created, sent, unknown — still in flight
  }
};

export interface PaynowInitiateParams {
  integrationId: string;
  integrationKey: string;
  authEmail: string;
  reference: string;
  amount: number;
  description: string;
  phone: string;
  // Paynow mobile method token: 'ecocash' | 'onemoney' (| 'omari' where enabled).
  method: string;
  resultUrl: string;
  returnUrl: string;
}

export interface PaynowInitiateResult {
  success: boolean;
  pollUrl?: string;
  instructions?: string;
  error?: string;
}

export interface PaynowStatusUpdate {
  status: PaymentStatus;
  reference?: string;
  // Uniquely identifies the attempt: every initiation gets its own poll URL,
  // which we persist as the payment's providerReference. The merchant reference
  // is only the order number, so it can't distinguish retries on its own.
  pollUrl?: string;
  // Raw Paynow status (e.g. 'cancelled') before collapsing — handy for logs.
  rawStatus?: string;
}

export const initiateMobilePayment = async ({
  integrationId,
  integrationKey,
  authEmail,
  reference,
  amount,
  description,
  phone,
  method,
  resultUrl,
  returnUrl,
}: PaynowInitiateParams): Promise<PaynowInitiateResult> => {
  const paynow = new Paynow(integrationId, integrationKey);
  paynow.resultUrl = resultUrl;
  paynow.returnUrl = returnUrl;

  const payment = paynow.createPayment(reference, authEmail);
  payment.add(description, amount);

  try {
    const response = await paynow.sendMobile(payment, phone, method);
    if (response.success) {
      return { success: true, pollUrl: response.pollUrl, instructions: response.instructions };
    }
    return { success: false, error: response.error };
  } catch (error) {
    logger.error(
      `${TAG} sendMobile failed for ${reference}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { success: false, error: 'Could not reach Paynow' };
  }
};

// SDK checks the hash and throws on mismatch, so a forged callback never settles.
export const parsePaynowStatusUpdate = (
  rawBody: string,
  integrationId: string,
  integrationKey: string,
): PaynowStatusUpdate => {
  const paynow = new Paynow(integrationId, integrationKey);
  const update = paynow.parseStatusUpdate(rawBody);
  return {
    status: mapStatus(update.status),
    reference: update.reference,
    pollUrl: update.pollUrl,
    rawStatus: update.status,
  };
};

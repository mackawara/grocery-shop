import { PaymentMethod, PaymentProvider, PaymentStatus } from '../../../constants/models';
import { logger } from '../../../services/logger';
import { initiateMobilePayment } from '../gateways/paynowClient';
import type {
  InitiatePaymentInput,
  InitiatePaymentResult,
  PaymentProviderAdapter,
  PaymentProviderContext,
} from './types';

const TAG = '[PAYNOW_PROVIDER]';

const PAYNOW_METHOD_TOKEN: Partial<Record<PaymentMethod, string>> = {
  [PaymentMethod.ECOCASH]: 'ecocash',
  [PaymentMethod.OMARI]: 'omari',
};

export const paynowProvider: PaymentProviderAdapter = {
  provider: PaymentProvider.PAYNOW,

  async initiate(
    input: InitiatePaymentInput,
    context: PaymentProviderContext,
  ): Promise<InitiatePaymentResult> {
    const credentials = context.credentials?.paynow;
    if (!credentials) {
      return {
        success: false,
        status: PaymentStatus.FAILED,
        error: 'Paynow is not configured for this merchant',
      };
    }
    if (!input.payerMobileNumber) {
      return {
        success: false,
        status: PaymentStatus.FAILED,
        error: 'A mobile number is required for Paynow payments',
      };
    }
    const methodToken = PAYNOW_METHOD_TOKEN[input.method];
    if (!methodToken) {
      return {
        success: false,
        status: PaymentStatus.FAILED,
        error: `Paynow does not support method ${input.method}`,
      };
    }

    const response = await initiateMobilePayment({
      integrationId: credentials.integrationId,
      integrationKey: credentials.integrationKey,
      authEmail: credentials.authEmail,
      reference: input.orderNumber,
      amount: input.amount,
      description: input.description,
      phone: input.payerMobileNumber,
      method: methodToken,
      resultUrl: context.resultUrl,
      returnUrl: context.returnUrl,
    });

    if (!response.success) {
      logger.warn(`${TAG} Initiation failed for ${input.orderNumber}: ${response.error}`);
      return { success: false, status: PaymentStatus.FAILED, error: response.error };
    }

    return {
      success: true,
      // Push sent; the customer must approve on-device. The webhook confirms.
      status: PaymentStatus.PENDING,
      providerReference: response.pollUrl,
      instructions: response.instructions,
    };
  },
};

import type { PaymentMethod, PaymentProvider, PaymentStatus } from '../../../constants/models.js';
import type { IPaymentCredentials } from '../../../models/Tenant.js';

// Adapters are pure gateway clients — they never touch the DB, Redis, or env;
// the orchestrator assembles everything they need.
export interface InitiatePaymentInput {
  orderNumber: string;
  amount: number;
  currency: string;
  description: string;
  method: PaymentMethod;
  // Required for mobile-money pushes; absent for cash on delivery.
  payerMobileNumber?: string;
}

export interface PaymentProviderContext {
  credentials?: IPaymentCredentials;
  resultUrl: string;
  // Unused by mobile push, but Paynow requires it to be present.
  returnUrl: string;
}

export interface InitiatePaymentResult {
  success: boolean;
  status: PaymentStatus;
  // pollUrl (Paynow) or gateway transaction id (direct APIs).
  providerReference?: string;
  instructions?: string;
  error?: string;
}

// Uniform gateway contract, so the orchestrator stays provider-agnostic.
export interface PaymentProviderAdapter {
  readonly provider: PaymentProvider;
  initiate(
    input: InitiatePaymentInput,
    context: PaymentProviderContext,
  ): Promise<InitiatePaymentResult>;
}

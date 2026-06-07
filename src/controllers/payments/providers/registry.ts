import { PaymentProvider } from '../../../constants/models';
import { paynowProvider } from './paynow.provider';
import type { PaymentProviderAdapter } from './types';

// Gateway → adapter. Standalone EcoCash/OMari get added here once built; cash
// on delivery has no adapter (settled manually via the orchestrator).
const PROVIDERS: Partial<Record<PaymentProvider, PaymentProviderAdapter>> = {
  [PaymentProvider.PAYNOW]: paynowProvider,
};

export const getProviderAdapter = (provider: PaymentProvider): PaymentProviderAdapter | undefined =>
  PROVIDERS[provider];

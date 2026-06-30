import { PaymentProvider } from '../../../constants/models.ts';
import { paynowProvider } from './paynow.provider.ts';
import type { PaymentProviderAdapter } from './types.ts';

// Gateway → adapter. Standalone EcoCash/OMari get added here once built; cash
// on delivery has no adapter (settled manually via the orchestrator).
const PROVIDERS: Partial<Record<PaymentProvider, PaymentProviderAdapter>> = {
  [PaymentProvider.PAYNOW]: paynowProvider,
};

export const getProviderAdapter = (provider: PaymentProvider): PaymentProviderAdapter | undefined =>
  PROVIDERS[provider];

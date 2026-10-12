import { Paynow } from 'paynow';

// Keep this boundary independent of configuration/HTTP so the signature and
// amount checks can be verified without production credentials or a gateway.
export const verifiedBillingUpdate = (
  rawBody: string,
  integrationId: string,
  integrationKey: string,
) => {
  const update = new Paynow(integrationId, integrationKey).parseStatusUpdate(rawBody);
  if (
    !update.reference ||
    !update.status ||
    !update.amount ||
    !/^\d+(\.\d{1,2})?$/.test(String(update.amount))
  ) {
    throw new Error('Invalid signed billing update');
  }
  const amountMinor = Math.round(Number(update.amount) * 100);
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new Error('Invalid billing payment amount');
  }
  return {
    reference: update.reference,
    status: update.status,
    pollUrl: update.pollUrl,
    amountMinor,
  };
};

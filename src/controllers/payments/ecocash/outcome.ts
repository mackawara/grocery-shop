// These are normalized business observations, not EcoCash wire status codes.
// A future adapter must verify the original merchant/environment/reference,
// USD amount and currency before emitting verified_paid or verified_failed.
export type EcoCashObservation =
  | 'verified_paid'
  | 'verified_failed'
  | 'pending'
  | 'unknown'
  | 'lookup_blocked';

export type EcoCashFinancialStatus = 'unresolved' | 'failed' | 'paid';
export type EcoCashReviewReason =
  | 'late_payment'
  | 'conflicting_evidence'
  | 'lookup_blocked'
  | 'sandbox_payment';

export interface EcoCashOutcomeInput {
  financialStatus: EcoCashFinancialStatus;
  reviewReasons: readonly EcoCashReviewReason[];
  observation: EcoCashObservation;
  environment: 'sandbox' | 'production';
  orderCancelled: boolean;
  // Persisted deadline of the first attempt; retries must reuse it.
  paymentDeadline: Date;
  // Local observation time: provider settlement-time semantics are unconfirmed.
  observedAt: Date;
}

export interface EcoCashOutcomeDecision {
  financialStatus: EcoCashFinancialStatus;
  orderAction: 'preserve' | 'confirm' | 'cancel_for_expiry';
  reviewReasons: EcoCashReviewReason[];
  // A caller must ALSO verify current owner consent, merchant readiness and
  // atomically exclude another pending/paid attempt before offering a retry.
  retryEligible: boolean;
}

// Pure policy only. Persistence must apply decisions atomically with a version
// check and notification outbox; this function provides no concurrency lock.
export const decideEcoCashOutcome = (input: EcoCashOutcomeInput): EcoCashOutcomeDecision => {
  const deadline = input.paymentDeadline.getTime();
  const observedAt = input.observedAt.getTime();
  if (!Number.isFinite(deadline) || !Number.isFinite(observedAt)) {
    throw new Error('Valid persisted payment deadline and observation time are required');
  }
  const expired = observedAt >= deadline;
  const reviewReasons = new Set(input.reviewReasons);
  let financialStatus = input.financialStatus;

  if (input.observation === 'verified_paid') {
    financialStatus = 'paid';
    // A repeated success after the deadline does not invalidate a payment
    // already recorded in time. A separate cancellation still requires review.
    if (input.orderCancelled || (input.financialStatus !== 'paid' && expired)) {
      reviewReasons.add('late_payment');
    }
    if (input.environment === 'sandbox') {
      reviewReasons.add('sandbox_payment');
    }
  } else if (input.observation === 'verified_failed') {
    if (financialStatus === 'paid') {
      reviewReasons.add('conflicting_evidence');
    } else {
      financialStatus = 'failed';
    }
  } else if (input.observation === 'lookup_blocked') {
    reviewReasons.add('lookup_blocked');
  } else if (financialStatus === 'failed' && input.observation === 'pending') {
    // A purportedly terminal failure now appears in flight: suppress retries.
    financialStatus = 'unresolved';
    reviewReasons.add('conflicting_evidence');
  }

  let orderAction: EcoCashOutcomeDecision['orderAction'] = 'preserve';
  if (!input.orderCancelled && input.environment === 'production') {
    if (expired && (financialStatus !== 'paid' || reviewReasons.has('late_payment'))) {
      orderAction = 'cancel_for_expiry';
    } else if (
      input.observation === 'verified_paid' &&
      input.financialStatus !== 'paid' &&
      !expired &&
      reviewReasons.size === 0
    ) {
      orderAction = 'confirm';
    }
  }

  return {
    financialStatus,
    orderAction,
    reviewReasons: [...reviewReasons],
    retryEligible:
      input.observation === 'verified_failed' &&
      financialStatus === 'failed' &&
      !expired &&
      !input.orderCancelled &&
      input.environment === 'production' &&
      reviewReasons.size === 0,
  };
};

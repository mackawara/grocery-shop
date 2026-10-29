import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decideEcoCashOutcome } from '../src/controllers/payments/ecocash/outcome.ts';
import type { EcoCashOutcomeInput } from '../src/controllers/payments/ecocash/outcome.ts';

const input = (overrides: Partial<EcoCashOutcomeInput> = {}): EcoCashOutcomeInput => ({
  financialStatus: 'unresolved',
  reviewReasons: [],
  observation: 'unknown',
  environment: 'production',
  orderCancelled: false,
  paymentDeadline: new Date('2026-10-29T10:05:00Z'),
  observedAt: new Date('2026-10-29T10:04:00Z'),
  ...overrides,
});

describe('direct EcoCash outcome policy', () => {
  it('never offers a replacement collection for pending or uncertain evidence', () => {
    for (const observation of ['pending', 'unknown', 'lookup_blocked'] as const) {
      const decision = decideEcoCashOutcome(input({ observation }));
      assert.equal(decision.financialStatus, 'unresolved');
      assert.equal(decision.orderAction, 'preserve');
      assert.equal(decision.retryEligible, false);
    }
  });

  it('allows a fresh action only after verified failure while the original window remains open', () => {
    assert.equal(
      decideEcoCashOutcome(input({ observation: 'verified_failed' })).retryEligible,
      true,
    );
    for (const overrides of [
      { orderCancelled: true },
      { observedAt: new Date('2026-10-29T10:05:00Z') },
      { reviewReasons: ['lookup_blocked'] as const },
      { environment: 'sandbox' as const },
    ]) {
      assert.equal(
        decideEcoCashOutcome(
          input({
            ...overrides,
            observation: 'verified_failed',
          }),
        ).retryEligible,
        false,
      );
    }
  });

  it('handles immediate and reconciled success identically, preserving prior timely success', () => {
    const first = decideEcoCashOutcome(input({ observation: 'verified_paid' }));
    assert.deepEqual(first, {
      financialStatus: 'paid',
      orderAction: 'confirm',
      reviewReasons: [],
      retryEligible: false,
    });
    const repeated = decideEcoCashOutcome(
      input({
        ...first,
        observation: 'verified_paid',
        observedAt: new Date('2026-10-29T10:06:00Z'),
      }),
    );
    assert.equal(repeated.financialStatus, 'paid');
    assert.equal(repeated.orderAction, 'preserve');
    assert.deepEqual(repeated.reviewReasons, []);
  });

  it('records late funds and cancels an order even when the expiry worker has not run', () => {
    for (const observedAt of ['2026-10-29T10:05:00Z', '2026-10-29T10:06:00Z']) {
      const decision = decideEcoCashOutcome(
        input({
          observation: 'verified_paid',
          observedAt: new Date(observedAt),
        }),
      );
      assert.equal(decision.financialStatus, 'paid');
      assert.equal(decision.orderAction, 'cancel_for_expiry');
      assert.deepEqual(decision.reviewReasons, ['late_payment']);
      assert.equal(decision.retryEligible, false);
    }
    assert.equal(
      decideEcoCashOutcome(
        input({
          orderCancelled: true,
          observation: 'verified_paid',
        }),
      ).orderAction,
      'preserve',
    );
  });

  it('expires unresolved or failed payments without claiming the provider cancelled them', () => {
    for (const financialStatus of ['unresolved', 'failed'] as const) {
      const decision = decideEcoCashOutcome(
        input({
          financialStatus,
          observedAt: new Date('2026-10-29T10:06:00Z'),
        }),
      );
      assert.equal(decision.financialStatus, financialStatus);
      assert.equal(decision.orderAction, 'cancel_for_expiry');
      assert.equal(decision.retryEligible, false);
    }
  });

  it('preserves paid evidence when later observations disagree or lookup fails', () => {
    for (const observation of [
      'verified_failed',
      'pending',
      'unknown',
      'lookup_blocked',
    ] as const) {
      const decision = decideEcoCashOutcome(input({ financialStatus: 'paid', observation }));
      assert.equal(decision.financialStatus, 'paid');
      assert.equal(decision.orderAction, 'preserve');
      assert.equal(decision.retryEligible, false);
    }
    assert.deepEqual(
      decideEcoCashOutcome(
        input({
          financialStatus: 'paid',
          observation: 'verified_failed',
        }),
      ).reviewReasons,
      ['conflicting_evidence'],
    );
  });

  it('blocks retries when an earlier failure becomes pending and keeps review obligations sticky', () => {
    const conflicting = decideEcoCashOutcome(
      input({
        financialStatus: 'failed',
        observation: 'pending',
      }),
    );
    assert.equal(conflicting.financialStatus, 'unresolved');
    assert.deepEqual(conflicting.reviewReasons, ['conflicting_evidence']);
    const laterSuccess = decideEcoCashOutcome(
      input({ ...conflicting, observation: 'verified_paid' }),
    );
    assert.equal(laterSuccess.financialStatus, 'paid');
    assert.equal(laterSuccess.orderAction, 'preserve');
    assert.deepEqual(laterSuccess.reviewReasons, ['conflicting_evidence']);
  });

  it('never settles an ordinary production order from sandbox success', () => {
    const decision = decideEcoCashOutcome(
      input({
        environment: 'sandbox',
        observation: 'verified_paid',
      }),
    );
    assert.equal(decision.financialStatus, 'paid');
    assert.equal(decision.orderAction, 'preserve');
    assert.deepEqual(decision.reviewReasons, ['sandbox_payment']);
    assert.equal(decision.retryEligible, false);
  });

  it('rejects missing timing evidence instead of accidentally confirming an order', () => {
    assert.throws(() => decideEcoCashOutcome(input({ paymentDeadline: new Date('invalid') })));
    assert.throws(() => decideEcoCashOutcome(input({ observedAt: new Date('invalid') })));
  });
});

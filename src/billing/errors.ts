import type { ScheduleViolation } from './rates.ts';
import type { RateField } from './types.ts';

export type BillingErrorCode = 'not_found' | ScheduleViolation['code'];

// An expected, explainable refusal (a business rule, not a fault). Controllers
// map the code to an HTTP status and show the message to the admin as is.
export class BillingRuleError extends Error {
  constructor(
    public readonly code: BillingErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BillingRuleError';
  }
}

const FIELD_LABELS: Record<RateField, string> = {
  setupFee: 'setup fee',
  monthlyFee: 'monthly fee',
  commissionBps: 'commission percentage',
  commissionFixedFee: 'fixed fee per order',
};

const describeViolation = (violation: ScheduleViolation): string => {
  switch (violation.code) {
    case 'not_future':
      return (
        'Rate changes start at the beginning of a future billing month. ' +
        `${violation.period} is not after the current month (${violation.currentPeriod}).`
      );
    case 'period_taken':
      return `A rate version already starts in ${violation.period}. Cancel it first to replace it.`;
    case 'in_effect':
      return (
        `This version took effect in ${violation.period} and is part of the billing history. ` +
        'Schedule a new version for a future month instead.'
      );
    case 'already_cancelled':
      return 'This version is already cancelled.';
    default: {
      const fields = violation.fields.map((field) => FIELD_LABELS[field]).join(', ');
      const verb = violation.direction === 'increase' ? 'raises' : 'lowers';
      return (
        `This change ${verb} the ${fields} from ${violation.period}, which needs at least ` +
        `${violation.requiredDays} days' notice; ${violation.noticeDays} remain before ` +
        `${violation.period} starts. Choose a later month.`
      );
    }
  }
};

export const violationError = (violation: ScheduleViolation): BillingRuleError =>
  new BillingRuleError(violation.code, describeViolation(violation), { ...violation });

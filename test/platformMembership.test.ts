import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isAllowlistedEmail, parsePlatformAdminEmails } from '../src/services/platformAllowlist.ts';

// The break-glass allowlist is the only path into the platform console that does
// not require a pre-existing PlatformUser row, so it has to work on a cold
// database — and it has to refuse everyone else.
describe('isAllowlistedAdmin', () => {
  it('parses the env list into the allowlist', () => {
    const allowlist = parsePlatformAdminEmails('ops@example.test, second@example.test');
    assert.equal(allowlist.has('ops@example.test'), true);
    assert.equal(allowlist.has('second@example.test'), true);
  });

  it('admits an allowlisted email', () => {
    const allowlist = parsePlatformAdminEmails('ops@example.test');
    assert.equal(isAllowlistedEmail('ops@example.test', allowlist), true);
  });

  it('admits an allowlisted email even though Authentik reports email_verified false', () => {
    // The regression this guards: the gate used to AND in that claim, which
    // Authentik hardcodes to false — so break-glass could never open and every
    // operator dead-ended at /no-access. The allowlist decision depends only on
    // the normalized address and the operator-controlled configured set.
    const allowlist = parsePlatformAdminEmails('ops@example.test');
    assert.equal(isAllowlistedEmail('ops@example.test', allowlist), true);
  });

  it('refuses an email that is not on the list', () => {
    const allowlist = parsePlatformAdminEmails('ops@example.test');
    assert.equal(isAllowlistedEmail('someone@example.test', allowlist), false);
  });

  it('refuses a missing email', () => {
    const allowlist = parsePlatformAdminEmails('ops@example.test');
    assert.equal(isAllowlistedEmail(undefined, allowlist), false);
  });

  it('refuses an empty email rather than matching a blank entry', () => {
    const allowlist = parsePlatformAdminEmails('ops@example.test,');
    assert.equal(isAllowlistedEmail('', allowlist), false);
  });
});

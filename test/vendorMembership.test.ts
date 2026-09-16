import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveMembership } from '../src/services/vendorMembership.ts';

// The seat-binding rule is the single gate between "an identity Authentik
// authenticated" and "a tenant's data". It is applied in three places that must
// agree (auth callback, dashboardAuthResolver, platformAdminResolver), so it is
// worth pinning down precisely — especially the email-anchor fallback, which is
// the only path that turns an address into tenant access.

type Row = { id: string; authSubject?: string; emailVerified?: boolean; authUserPk?: number };

// Stand-in for the injected finder. Matches the same way Mongo would: exact
// authSubject or exact email.
const finder =
  (rows: Array<Row & { email?: string }>) =>
  (filter: { authSubject: string } | { email: string }): Promise<Row | null> => {
    const match = rows.find((r) =>
      'authSubject' in filter ? r.authSubject === filter.authSubject : r.email === filter.email,
    );
    return Promise.resolve(match ?? null);
  };

describe('resolveMembership', () => {
  it('matches on the OIDC subject first, ignoring email entirely', async () => {
    const found = await resolveMembership(
      'sub-1',
      'owner@shop.test',
      false,
      finder([{ id: 'bound', authSubject: 'sub-1', email: 'other@shop.test' }]),
    );
    assert.equal(found?.id, 'bound');
  });

  it('binds on the email anchor when WE verified the email, even though the IdP claim is false', async () => {
    // The regression this guards: Authentik hardcodes email_verified to false
    // (2025.10+), so requiring the claim denied every first login.
    const found = await resolveMembership(
      'sub-new',
      'owner@shop.test',
      false,
      finder([{ id: 'seat', email: 'owner@shop.test', emailVerified: true }]),
    );
    assert.equal(found?.id, 'seat');
  });

  it('binds on the email anchor when a federated IdP vouches, even without our own flag', async () => {
    const found = await resolveMembership(
      'sub-new',
      'owner@shop.test',
      true,
      finder([{ id: 'seat', email: 'owner@shop.test', emailVerified: false }]),
    );
    assert.equal(found?.id, 'seat');
  });

  it('refuses an unverified email anchor', async () => {
    const found = await resolveMembership(
      'sub-new',
      'owner@shop.test',
      false,
      finder([{ id: 'seat', email: 'owner@shop.test', emailVerified: false }]),
    );
    assert.equal(found, null);
  });

  it('treats a missing emailVerified field as unverified', async () => {
    const found = await resolveMembership(
      'sub-new',
      'owner@shop.test',
      false,
      finder([{ id: 'seat', email: 'owner@shop.test' }]),
    );
    assert.equal(found, null);
  });

  it('refuses to rebind an email already bound to a different subject', async () => {
    // Even a verified address must not hand one identity another's seat.
    const found = await resolveMembership(
      'attacker-sub',
      'owner@shop.test',
      true,
      finder([
        { id: 'seat', email: 'owner@shop.test', authSubject: 'owner-sub', emailVerified: true },
      ]),
    );
    assert.equal(found, null);
  });

  it('binds a row we provisioned ourselves, pending issue #51 (interim provenance path)', async () => {
    const found = await resolveMembership(
      'sub-new',
      'owner@shop.test',
      false,
      finder([{ id: 'seat', email: 'owner@shop.test', authUserPk: 42 }]),
    );
    assert.equal(found?.id, 'seat');
  });

  it('still refuses a row we did NOT provision and nobody verified', async () => {
    // The provenance path must not become "any row with an email matches".
    const found = await resolveMembership(
      'sub-new',
      'owner@shop.test',
      false,
      finder([{ id: 'seat', email: 'owner@shop.test', emailVerified: false }]),
    );
    assert.equal(found, null);
  });

  it('provenance never overrides an email already bound to another subject', async () => {
    const found = await resolveMembership(
      'attacker-sub',
      'owner@shop.test',
      false,
      finder([
        { id: 'seat', email: 'owner@shop.test', authSubject: 'owner-sub', authUserPk: 42 },
      ]),
    );
    assert.equal(found, null);
  });

  it('returns null when the token carries no email and no subject matches', async () => {
    const found = await resolveMembership(
      'sub-new',
      undefined,
      true,
      finder([{ id: 'seat', email: 'owner@shop.test', emailVerified: true }]),
    );
    assert.equal(found, null);
  });

  it('returns null when no row matches at all', async () => {
    const found = await resolveMembership('sub-new', 'nobody@shop.test', true, finder([]));
    assert.equal(found, null);
  });
});

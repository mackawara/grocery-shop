import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PlatformRole, PlatformUserStatus } from '../src/constants/models.ts';
import { PlatformGrantSource } from '../src/constants/platformGrantSource.ts';
import { canUsePlatformGrant } from '../src/services/platformGrant.ts';

const activeSuper = { role: PlatformRole.SUPER_ADMIN, status: PlatformUserStatus.ACTIVE };

describe('platform grant authorization', () => {
  it('revokes an allowlist-derived grant when the email is removed', () => {
    const row = { ...activeSuper, grantSource: PlatformGrantSource.ALLOWLIST };
    assert.equal(canUsePlatformGrant(row, true), true);
    assert.equal(canUsePlatformGrant(row, false), false);
  });

  it('allows an independent provisioned admin without the allowlist', () => {
    const row = { ...activeSuper, grantSource: PlatformGrantSource.PROVISIONED };
    assert.equal(canUsePlatformGrant(row, false), true);
  });

  it('treats unclassified legacy records conservatively', () => {
    assert.equal(canUsePlatformGrant(activeSuper, true), true);
    assert.equal(canUsePlatformGrant(activeSuper, false), false);
  });

  it('denies disabled records', () => {
    assert.equal(
      canUsePlatformGrant(
        {
          ...activeSuper,
          grantSource: PlatformGrantSource.PROVISIONED,
          status: PlatformUserStatus.DISABLED,
        },
        false,
      ),
      false,
    );
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { preparePlatformAdminPassword } from '../src/scripts/platformAdminPassword.ts';

describe('preparePlatformAdminPassword', () => {
  it('rejects empty piped input before provisioning', async () => {
    await assert.rejects(
      preparePlatformAdminPassword(
        true,
        false,
        async () => ' \n ',
        () => 'unused',
      ),
      /No password supplied/,
    );
  });

  it('passes a supplied password without calling the generator', async () => {
    let generated = false;
    const password = await preparePlatformAdminPassword(
      true,
      false,
      async () => 'secret from stdin',
      () => {
        generated = true;
        return 'unused';
      },
    );
    assert.equal(password, 'secret from stdin');
    assert.equal(generated, false);
  });

  it('generates only when requested', async () => {
    assert.equal(
      await preparePlatformAdminPassword(
        false,
        true,
        async () => 'unused',
        () => 'generated',
      ),
      'generated',
    );
  });
});

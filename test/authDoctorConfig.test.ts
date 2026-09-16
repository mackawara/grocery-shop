import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';

import { readAuthDoctorConfig } from '../src/scripts/authDoctorConfig.ts';

describe('readAuthDoctorConfig', () => {
  it('does not require unrelated application settings', () => {
    const config = readAuthDoctorConfig({
      AUTHENTIK_ISSUER: 'https://auth.example.test/application/o/shop/',
      AUTHENTIK_BASE_URL: 'https://auth.example.test',
      AUTHENTIK_CLIENT_ID: 'shop',
      AUTHENTIK_CLIENT_SECRET: 'synthetic',
      AUTHENTIK_ADMIN_TOKEN: 'synthetic',
      PUBLIC_BASE_URL: 'https://api.example.test',
      DASHBOARD_URL: 'https://dashboard.example.test',
    });

    assert.equal(config.AUTH_REDIRECT_URI, 'https://api.example.test/auth/callback');
    assert.equal(config.AUTHENTIK_POST_LOGOUT_REDIRECT, 'https://dashboard.example.test');
  });

  it('reports missing values as empty and honors explicit URL overrides', () => {
    const missing = readAuthDoctorConfig({});
    const local = readAuthDoctorConfig({
      APP_ENV: 'LOCAL',
      NGROK_DOMAIN: 'shop.ngrok.example',
      AUTH_REDIRECT_URI: 'https://other.example.test/auth/callback',
      AUTHENTIK_POST_LOGOUT_REDIRECT: 'https://other.example.test/logout',
    });

    assert.equal(missing.AUTHENTIK_ADMIN_TOKEN, '');
    assert.equal(missing.AUTH_REDIRECT_URI, '');
    assert.equal(local.AUTH_REDIRECT_URI, 'https://other.example.test/auth/callback');
    assert.equal(local.AUTHENTIK_POST_LOGOUT_REDIRECT, 'https://other.example.test/logout');
  });

  it('prints its own missing-config report before any request', () => {
    // Empty values block a local .env from filling these keys. The command must
    // exit in checkEnv, before it can contact the configured Authentik instance.
    const env = {
      ...process.env,
      AUTHENTIK_ISSUER: '',
      AUTHENTIK_BASE_URL: '',
      AUTHENTIK_CLIENT_ID: '',
      AUTHENTIK_CLIENT_SECRET: '',
      AUTHENTIK_ADMIN_TOKEN: '',
      AUTH_REDIRECT_URI: '',
      PUBLIC_BASE_URL: '',
      NGROK_DOMAIN: '',
    };
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', path.resolve('src/scripts/authDoctor.ts')],
      { env, encoding: 'utf8', timeout: 15_000 },
    );

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /Environment: missing:/);
    assert.match(result.stdout, /1 failure\(s\)/);
  });
});

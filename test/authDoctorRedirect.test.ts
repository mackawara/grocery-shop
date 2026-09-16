import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkRedirectEntry } from '../src/scripts/authDoctorRedirect.ts';

const auth = {
  url: 'https://api.example.test/auth/callback',
  matching_mode: 'strict',
  redirect_uri_type: 'authorization',
};
const logout = {
  url: 'https://dashboard.example.test/',
  matching_mode: 'strict',
  redirect_uri_type: 'logout',
};

describe('checkRedirectEntry', () => {
  it('keeps authorization and logout redirects separate', () => {
    assert.equal(checkRedirectEntry([logout], logout.url, 'authorization').status, 'fail');
    assert.equal(checkRedirectEntry([auth], auth.url, 'logout').status, 'fail');
    assert.equal(checkRedirectEntry([auth, logout], auth.url, 'authorization').status, 'pass');
    assert.equal(checkRedirectEntry([auth, logout], logout.url, 'logout').status, 'pass');
  });

  it('uses full regex matching for the matching entry type', () => {
    const regex = {
      url: 'https://api\\.example\\.test/auth/.*',
      matching_mode: 'regex',
      redirect_uri_type: 'authorization',
    };
    assert.equal(
      checkRedirectEntry([regex], 'https://api.example.test/auth/callback', 'authorization').status,
      'pass',
    );
    assert.equal(
      checkRedirectEntry([regex], 'https://api.example.test/auth/callback/extra', 'logout').status,
      'fail',
    );
  });

  it('warns on untyped or malformed entries', () => {
    assert.equal(checkRedirectEntry([auth.url], auth.url, 'authorization').status, 'warn');
    assert.equal(
      checkRedirectEntry([{ ...auth, url: '(', matching_mode: 'regex' }], auth.url, 'authorization')
        .status,
      'warn',
    );
  });
});

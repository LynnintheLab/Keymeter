import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createFormProtection, verifiedForm, FORM_TTL } from '../security.mjs';

test('HTML form proofs support embedded browsers without accepting forged requests', () => {
  Object.assign(process.env, {
    APP_URL: 'https://keys.example.test', DB_HOST: '127.0.0.1', DB_NAME: 'synthetic', DB_USER: 'synthetic', DB_PASSWORD: 'synthetic',
    ADMIN_PASSWORD_HASH: `scrypt$${randomBytes(16).toString('base64url')}$${randomBytes(32).toString('base64url')}`,
    SESSION_SECRET: randomBytes(32).toString('base64url'), BILLING_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  });
  const now = Date.now();
  const proof = createFormProtection({}, now);
  assert.match(proof.cookie, /^__Host-keymeter-form=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=3600; Secure$/);
  const cookie = proof.cookie.split(';')[0];
  for (const origin of [undefined, 'null', process.env.APP_URL]) {
    assert.equal(verifiedForm({ cookie, ...(origin ? { origin } : {}) }, proof.token, now), true);
  }
  assert.equal(verifiedForm({ cookie, origin: 'null', 'sec-fetch-site': 'cross-site' }, proof.token, now), true,
    'A signed session-bound form proof is the CSRF fallback for embedded-browser metadata.');
  assert.equal(verifiedForm({ cookie, origin: 'https://foreign.example.test' }, proof.token, now), false);
  assert.equal(verifiedForm({ origin: process.env.APP_URL }, proof.token, now), false);
  assert.equal(verifiedForm({ cookie }, '', now), false);
  assert.equal(verifiedForm({ cookie }, proof.token.replace(/\..*/, '.' + 'A'.repeat(43)), now), false);
  assert.equal(verifiedForm({ cookie: `${cookie}; ${cookie}` }, proof.token, now), false);
  assert.equal(verifiedForm({ cookie }, proof.token, now + FORM_TTL * 1000), false);
  assert.equal(verifiedForm({ cookie }, proof.token, now - 1000), false);
  const otherBrowser = createFormProtection({}, now);
  assert.equal(verifiedForm({ cookie: otherBrowser.cookie.split(';')[0] }, proof.token, now), false);
  process.env.APP_URL = 'https://other.example.test';
  assert.equal(verifiedForm({ cookie }, proof.token, now), false);
  process.env.APP_URL = 'http://127.0.0.1:5175';
  const loginCookie = 'keymeter-session=' + randomBytes(32).toString('base64url');
  const pendingCookie = 'keymeter-preauth=' + randomBytes(32).toString('base64url');
  const sessionProof = createFormProtection({ cookie: `${loginCookie}; ${pendingCookie}` }, now);
  assert.doesNotMatch(sessionProof.cookie, /Secure|Domain=/);
  const browserCookie = sessionProof.cookie.split(';')[0];
  const bound = { cookie: `${browserCookie}; ${loginCookie}; ${pendingCookie}` };
  assert.equal(verifiedForm(bound, sessionProof.token, now), true);
  assert.equal(verifiedForm({ cookie: `${browserCookie}; ${loginCookie}` }, sessionProof.token, now), false);
  assert.equal(verifiedForm({ cookie: `${browserCookie}; ${pendingCookie}` }, sessionProof.token, now), false);
  assert.ok(!sessionProof.token.includes(loginCookie.split('=')[1]), 'The form must not disclose the authentication credential.');
});

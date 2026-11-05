import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare } from './worker-fixture.mjs';
import {
  limitSellerPassword, loginSellerPassword, logoutSellerPassword, sellerAccess,
  sellerCookieHeader, sellerOwner, sellerSameOrigin, setupSellerPassword, SELLER_SESSION_SECONDS,
} from '../lib/seller-auth.ts';

const owner = { userId: 'synthetic-owner-id', email: 'owner@example.test' };
const password = 'synthetic owner password for billing';
const secret = randomBytes(32).toString('base64');
const configFor = DB => ({ DB, BILLING_ENCRYPTION_KEY: secret, KEYMETER_OWNER_EMAIL: owner.email });
const cookieFor = token => sellerCookieHeader(token).split(';')[0];
async function database(t) {
  const worker = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("fixture"); } };', d1Databases: ['DB'] });
  t.after(() => worker.dispose());
  const db = await worker.getD1Database('DB');
  const directory = new URL('../drizzle/', import.meta.url);
  for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
    const sql = await readFile(new URL(name, directory), 'utf8');
    await db.batch(sql.split('--> statement-breakpoint').map(statement => db.prepare(statement)));
  }
  return db;
}

test('billing password sessions bind the verified owner, expire and revoke without disconnecting RunningHub', async t => {
  const db = await database(t), config = configFor(db), now = Date.parse('2026-11-05T01:00:00Z');
  assert.equal(await sellerAccess(config, owner, '', now), 'setup');
  await assert.rejects(setupSellerPassword(config, owner, 'too-short', now), error => error.status === 400);
  const token = await setupSellerPassword(config, owner, password, now);
  const cookie = cookieFor(token);
  assert.match(sellerCookieHeader(token), /^__Host-keymeter-seller=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800$/);
  assert.equal(await sellerAccess(config, owner, cookie, now), 'unlocked');
  assert.equal(await sellerAccess(config, owner, cookie, now + SELLER_SESSION_SECONDS * 1000), 'locked');
  assert.equal(await sellerAccess(config, { ...owner, userId: 'different-verified-owner-id' }, cookie, now), 'locked');
  assert.equal(await sellerAccess(config, { userId: 'customer', email: 'customer@example.test' }, cookie, now), 'locked');
  assert.equal(await sellerAccess(config, owner, cookie + '; ' + cookie, now), 'locked');
  await assert.rejects(loginSellerPassword(config, owner, password + 'wrong', now), error => error.status === 401);
  const second = await loginSellerPassword(config, owner, password, now);
  await assert.rejects(setupSellerPassword(config, owner, password + 'other', now), error => error.status === 409);
  assert.equal(await sellerAccess(config, owner, cookieFor(second), now), 'unlocked');
  await db.prepare('INSERT INTO billing_connection (id, encrypted_session, updated_at, refresh_lock_until) VALUES (1, ?, ?, 0)')
    .bind('opaque-ciphertext-preserved', 'synthetic-time').run();
  await logoutSellerPassword(config, owner, cookieFor(second));
  assert.equal(await sellerAccess(config, owner, cookieFor(second), now), 'locked');
  assert.equal((await db.prepare('SELECT encrypted_session FROM billing_connection WHERE id = 1').first()).encrypted_session, 'opaque-ciphertext-preserved');
  const saved = JSON.stringify(await db.prepare('SELECT * FROM seller_password').all()) + JSON.stringify(await db.prepare('SELECT * FROM seller_sessions').all());
  assert.ok(!saved.includes(password));
  assert.ok(!saved.includes(token));
  assert.ok(!saved.includes(owner.email));
  assert.equal(sellerOwner(null, config), false);
  assert.equal(sellerSameOrigin(new Request('https://checker.test/api/seller/auth', { method: 'POST' })), false);
  assert.equal(sellerSameOrigin(new Request('https://checker.test/api/seller/auth', { method: 'POST', headers: { origin: 'https://evil.test' } })), false);
});

test('password setup has one atomic winner across independent isolates and short rate windows recover', async t => {
  const db = await database(t), config = configFor(db), now = Date.parse('2026-11-05T01:00:01Z');
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('../lib/seller-auth.ts', import.meta.url))], bundle: true, format: 'esm', external: ['node:*'], write: false });
  const module = 'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64');
  const [one, two] = await Promise.all([import(module + '#one'), import(module + '#two')]);
  const outcomes = await Promise.allSettled([
    one.setupSellerPassword(config, owner, password, now),
    two.setupSellerPassword(config, owner, password + 'different', now),
  ]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = outcomes.find(result => result.status === 'rejected');
  assert.equal(rejected.reason.status, 409);
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM seller_password').first()).count, 1);
  const request = new Request('https://checker.test/api/seller/auth', { method: 'POST', headers: { origin: 'https://checker.test', 'cf-connecting-ip': '192.0.2.20' } });
  for (let i = 0; i < 4; i++) await limitSellerPassword(request, config, owner, now);
  await assert.rejects(limitSellerPassword(request, config, owner, now), error => error.status === 429 && error.retryAfter === 9);
  await limitSellerPassword(request, config, owner, now + 10_000);
  const buckets = JSON.stringify(await db.prepare('SELECT * FROM request_limits').all());
  assert.ok(!buckets.includes(owner.email));
  assert.ok(!buckets.includes('192.0.2.20'));
});

test('actual Worker seller routes enforce owner identity, password cookie, CSRF and body bounds before billing access', async t => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const bundle = await build({
    stdin: { contents: `
      import * as auth from './app/api/seller/auth/route.ts';
      import * as billing from './app/api/seller/billing/route.ts';
      import {setIdentity} from 'fixture-identity';
      export default { async fetch(request) {
        setIdentity(request.headers.get('x-fixture-owner') === 'yes' ? {userId: request.headers.get('x-fixture-owner-id') || 'synthetic-owner-id', email:'owner@example.test'} : null);
        const handlers = new URL(request.url).pathname.endsWith('/auth') ? auth : billing;
        return handlers[request.method]?.(request) || new Response('method', {status:405});
      }};`, resolveDir: root, sourcefile: 'seller-auth-worker.ts' },
    bundle: true, format: 'esm', external: ['node:*', 'cloudflare:workers'], write: false,
    plugins: [{ name: 'verified-identity-fixture', setup(build) {
      build.onResolve({ filter: /^(fixture-identity|@\/app\/chatgpt-auth)$/ }, () => ({ path: 'identity', namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'let identity=null; export function setIdentity(value){identity=value}; export async function getChatGPTUser(){return identity}' }));
    }}],
  });
  const worker = new Miniflare({ modules: true, compatibilityDate: '2026-05-15', compatibilityFlags: ['nodejs_compat'], script: bundle.outputFiles[0].text,
    d1Databases: ['DB'], bindings: { BILLING_ENCRYPTION_KEY: secret, KEYMETER_OWNER_EMAIL: owner.email } });
  t.after(() => worker.dispose());
  const db = await worker.getD1Database('DB');
  const directory = new URL('../drizzle/', import.meta.url);
  for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
    await db.batch((await readFile(new URL(name, directory), 'utf8')).split('--> statement-breakpoint').map(statement => db.prepare(statement)));
  }
  const headers = { 'x-fixture-owner': 'yes', origin: 'https://checker.test', 'content-type': 'application/json' };
  const authUrl = 'https://checker.test/api/seller/auth', billingUrl = 'https://checker.test/api/seller/billing';
  for (const method of ['GET', 'POST', 'DELETE']) {
    assert.equal((await worker.dispatchFetch(billingUrl, { method, headers: { origin: 'https://checker.test' } })).status, 403);
    assert.equal((await worker.dispatchFetch(billingUrl, { method, headers })).status, 401);
  }
  assert.equal((await worker.dispatchFetch(authUrl, { method: 'POST', headers: { ...headers, origin: 'https://evil.test' }, body: JSON.stringify({ action: 'setup', password }) })).status, 403);
  assert.equal((await worker.dispatchFetch(authUrl, { method: 'POST', headers: { 'x-fixture-owner': 'yes', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'setup', password }) })).status, 403);
  assert.equal((await worker.dispatchFetch(authUrl, { method: 'POST', headers, body: JSON.stringify({ action: 'setup', password: 'x'.repeat(5000) }) })).status, 400);
  const setup = await worker.dispatchFetch(authUrl, { method: 'POST', headers, body: JSON.stringify({ action: 'setup', password }) });
  assert.equal(setup.status, 200, await setup.text());
  const cookie = setup.headers.get('set-cookie').split(';')[0];
  assert.match(setup.headers.get('cache-control'), /no-store/);
  assert.equal((await worker.dispatchFetch(billingUrl, { headers: { ...headers, cookie } })).status, 200);
  assert.equal((await worker.dispatchFetch(billingUrl, { method: 'DELETE', headers: { ...headers, cookie, origin: 'https://evil.test' } })).status, 403);
  assert.equal((await worker.dispatchFetch(billingUrl, { headers: { ...headers, cookie: '__Host-keymeter-seller=' + 'A'.repeat(43) } })).status, 401);
  assert.equal((await worker.dispatchFetch(billingUrl, { headers: { ...headers, cookie, 'x-fixture-owner-id': 'different-owner-id' } })).status, 401);
  const wrong = await worker.dispatchFetch(authUrl, { method: 'POST', headers, body: JSON.stringify({ action: 'login', password: password + 'wrong' }) });
  assert.equal(wrong.status, 401);
  const login = await worker.dispatchFetch(authUrl, { method: 'POST', headers, body: JSON.stringify({ action: 'login', password }) });
  assert.equal(login.status, 200);
  const loginCookie = login.headers.get('set-cookie').split(';')[0];
  const logout = await worker.dispatchFetch(authUrl, { method: 'DELETE', headers: { ...headers, cookie: loginCookie } });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await worker.dispatchFetch(billingUrl, { headers: { ...headers, cookie: loginCookie } })).status, 401);
});

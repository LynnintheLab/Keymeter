import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from './worker-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const key = 'aaaa' + 'k'.repeat(24) + '9876';
const encryptionKey = Buffer.alloc(32, 7).toString('base64');
const { outputFiles } = await build({
  stdin: { contents: `
    import { POST as balance } from './app/api/allowance/route';
    import { POST as history } from './app/api/usage-history/route';
    export default { fetch(req) { return new URL(req.url).pathname === '/api/usage-history' ? history(req) : balance(req); } };
  `, resolveDir: root }, absWorkingDir: root, bundle: true, format: 'esm', write: false,
  external: ['cloudflare:workers'],
});
const billingLibrary = await build({ entryPoints: [fileURLToPath(new URL('../lib/billing.ts', import.meta.url))],
  bundle: true, format: 'esm', write: false });
const { connectSeller } = await import('data:text/javascript;base64,' + Buffer.from(billingLibrary.outputFiles[0].text).toString('base64'));

async function fixture(t, withSecret = true, provider) {
  const calls = [];
  const worker = new Miniflare({ modules: true, compatibilityDate: '2026-05-15', script: outputFiles[0].text,
    d1Databases: ['DB'], bindings: withSecret ? { BILLING_ENCRYPTION_KEY: encryptionKey } : {},
    outboundService(req) {
      calls.push(req.url);
      if (provider) return provider(req);
      assert.equal(req.url, 'https://www.runninghub.ai/openapi/v2/api-key/list', 'A balance check must not call seller endpoints.');
      assert.equal(req.headers.get('authorization'), 'Bearer ' + key);
      return Response.json({ code: 0, data: [{ key: 'aaaa****9876', quotaLimit: 20, quotaUsed: '5.123',
        expireAt: null, createdAt: '2026-01-01T00:00:00Z' }] });
    } });
  t.after(() => worker.dispose());
  const db = await worker.getD1Database('DB');
  const directory = new URL('../drizzle/', import.meta.url);
  for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
    const sql = await readFile(new URL(name, directory), 'utf8');
    await db.batch(sql.split('--> statement-breakpoint').map(statement => db.prepare(statement)));
  }
  const submit = (path, input = { key }, headers = {}) => worker.dispatchFetch('https://checker.test' + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(input),
  });
  return { db, calls, submit };
}

test('balance-only checks need no seller token and ignore a broken saved session', async t => {
  const { db, calls, submit } = await fixture(t);
  for (const saved of [false, true]) {
    if (saved) await db.prepare('INSERT INTO billing_connection (id, encrypted_session, updated_at, refresh_lock_until) VALUES (1, ?, ?, 0)')
      .bind('synthetic-corrupt-ciphertext', new Date().toISOString()).run();
    const response = await submit('/api/allowance', { key, includeTasks: false });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /no-store/);
    const result = await response.json();
    assert.equal(result.remaining, 14.877);
    assert.equal(result.limit, 20);
    assert.equal(result.used, 5.123);
    assert.equal('tasks' in result, false);
    assert.equal(result.history.length, saved ? 2 : 1);
    assert.ok(!JSON.stringify(result).includes(key));
    assert.ok(!JSON.stringify(result).includes('ciphertext'));
  }
  assert.equal(calls.length, 2);
  const history = await (await submit('/api/usage-history')).json();
  assert.deepEqual(history, { state: 'unavailable', records: [], hasMore: false });
  assert.equal(calls.length, 3);
});

test('missing billing secret and missing seller connection do not block balance', async t => {
  const { calls, submit } = await fixture(t, false);
  const result = await (await submit('/api/allowance', { key, includeTasks: false })).json();
  assert.equal(result.remaining, 14.877);
  assert.deepEqual(await (await submit('/api/usage-history')).json(), { state: 'not_connected', records: [], hasMore: false });
  assert.equal(calls.length, 1, 'Disconnected history must not make an additional RunningHub call.');
});

test('history requests validate origin and full key before provider access', async t => {
  const { calls, submit } = await fixture(t);
  assert.equal((await submit('/api/usage-history', { key }, { origin: 'https://evil.test' })).status, 403);
  assert.equal((await submit('/api/usage-history', { key: 'aaaa****9876' })).status, 400);
  assert.deepEqual(await (await submit('/api/usage-history')).json(), { state: 'not_connected', records: [], hasMore: false });
  assert.equal(calls.length, 0);
});

test('separate history verifies the full key and ignores forged browser account metadata', async t => {
  const siblingKey = 'bbbb' + 'b'.repeat(24) + '9876';
  const foreignCollision = 'aaaa' + 'z'.repeat(24) + '9876';
  const rejectedKey = 'cccc' + 'c'.repeat(24) + '9876';
  const sessionToken = 'synthetic-seller-session-token-for-history-test';
  const roster = [
    { apiKeyId: 'owned-1', key: 'aaaa****9876', createdAt: '2026-01-01T00:00:00.000Z', isSystemAuto: false },
    { apiKeyId: 'owned-2', key: 'bbbb****9876', createdAt: '2026-01-02T00:00:00.000Z', isSystemAuto: false },
  ];
  const billingRequests = [];
  let returnSiblingRecord = false;
  const { db, calls, submit } = await fixture(t, true, async req => {
    const path = new URL(req.url).pathname;
    if (path === '/openapi/v2/api-key/list') {
      const submitted = req.headers.get('authorization').slice('Bearer '.length);
      assert.ok([key, siblingKey, foreignCollision, rejectedKey].includes(submitted));
      if (submitted === rejectedKey) return new Response(null, { status: 401 });
      return Response.json({ code: 0, data: roster.map(row => ({ key: row.key,
        createdAt: submitted === foreignCollision && row.apiKeyId === 'owned-1'
          ? '2026-01-01T00:00:01.000Z' : row.createdAt,
        quotaLimit: 20, quotaUsed: '5.123', expireAt: null })) });
    }
    assert.equal(req.headers.get('authorization'), 'Bearer ' + sessionToken);
    const body = await req.json();
    if (path === '/api/key/list') {
      assert.deepEqual(body, { type: 'SHARED' });
      return Response.json({ code: 0, data: roster });
    }
    assert.equal(path, '/api/billing/usage/wideDetails');
    assert.ok(['owned-1', 'owned-2'].includes(body.apiKeyId));
    billingRequests.push(body);
    const selected = returnSiblingRecord ? 'owned-2' : body.apiKeyId;
    return Response.json({ code: 0, data: { hasNext: false, records: [{ apiKeyId: selected,
      taskId: 'job-' + selected, createTime: '2026-11-04 17:00:00', taskName: 'Model ' + selected,
      taskStatus: 'SUCCESS', moneyAmount: selected === 'owned-1' ? '0.125' : '0.25' }] } });
  });
  await connectSeller(db, encryptionKey, sessionToken, '', async (url, init) => {
    assert.equal(init.headers.Authorization, 'Bearer ' + sessionToken);
    if (url.endsWith('/api/key/queryAllV2')) return Response.json({ code: 0,
      data: { SHARED: roster.map(row => ({ apiKeyId: row.apiKeyId, mask: row.key, userId: 'seller-1' })) } });
    assert.ok(url.endsWith('/uc/getUserInfo'));
    return Response.json({ code: 0, data: { walletInfo: { currency: 'USD' } } });
  });

  // A browser cannot choose a sibling's billing ID, even with a genuine roster.
  const forgedMetadata = { apiKeyId: 'owned-2', identity: roster.map(row => ({ mask: row.key, createdAt: row.createdAt })),
    allowance: { remaining: 999, limit: 999, used: 0 } };
  const response = await submit('/api/usage-history', { key, ...forgedMetadata });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /no-store/);
  const own = await response.json();
  assert.deepEqual(own, { state: 'ready', hasMore: false, records: [{ taskId: 'job-owned-1',
    time: '2026-11-04T09:00:00.000Z', name: 'Model owned-1', status: 'SUCCESS', cost: 0.125, currency: 'USD' }] });
  assert.equal(billingRequests[0].apiKeyId, 'owned-1');
  assert.doesNotMatch(JSON.stringify(own), new RegExp(sessionToken + '|' + key + '|apiKeyId'));

  const sibling = await (await submit('/api/usage-history', { key: siblingKey, apiKeyId: 'owned-1' })).json();
  assert.equal(sibling.state, 'ready');
  assert.equal(sibling.records[0].taskId, 'job-owned-2');
  assert.equal(billingRequests[1].apiKeyId, 'owned-2');

  // Equal prefix/suffix text is insufficient when provider-authenticated account
  // metadata differs. Forged browser metadata must not repair that mismatch.
  const billedBefore = billingRequests.length;
  const collision = await (await submit('/api/usage-history', { key: foreignCollision, ...forgedMetadata })).json();
  assert.deepEqual(collision, { state: 'unavailable', records: [], hasMore: false });
  assert.equal(billingRequests.length, billedBefore);

  const callsBeforeRejection = calls.length;
  const rejected = await (await submit('/api/usage-history', { key: rejectedKey, ...forgedMetadata })).json();
  assert.deepEqual(rejected, { state: 'unavailable', records: [], hasMore: false });
  assert.equal(calls.length, callsBeforeRejection + 1, 'Rejected keys must not query seller records.');
  assert.equal(billingRequests.length, billedBefore);

  // Even after valid authorization, a provider response attributed to a sibling
  // must fail closed instead of exposing that sibling's job charge.
  returnSiblingRecord = true;
  assert.deepEqual(await (await submit('/api/usage-history', { key })).json(),
    { state: 'unavailable', records: [], hasMore: false });
});

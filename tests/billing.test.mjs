import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { Miniflare } from './worker-fixture.mjs';
const library = await build({ entryPoints: [fileURLToPath(new URL('../lib/billing.ts', import.meta.url))], bundle: true, format: 'esm', write: false });
const { projectTasks, connectSeller } = await import('data:text/javascript;base64,' + Buffer.from(library.outputFiles[0].text).toString('base64'));

const siteRoot = fileURLToPath(new URL('../', import.meta.url));
async function migrate(db) {
  const directory = new URL('../drizzle/', import.meta.url);
  const migrations = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
  for (const name of migrations) {
    const sql = await readFile(new URL(name, directory), 'utf8');
    await db.batch(sql.split('--> statement-breakpoint').map(statement => db.prepare(statement)));
  }
}
const key = 'aaaa' + 'a'.repeat(24) + 'same';
const other = 'bbbb' + 'b'.repeat(24) + 'same';
const masks = ['aaaa****same', 'bbbb****same'];
const sessionToken = 'synthetic-seller-session-token-for-test';
const encryptionKey = randomBytes(32).toString('base64');
const keys = { SHARED: masks.map((mask, index) => ({ apiKeyId: String(index + 1), mask, userId: 99 })) };
const record = (apiKeyId = '1') => ({ apiKeyId, taskId: 'task-01', createTime: '2026-11-04 17:00:00', taskName: 'Synthetic model', taskStatus: 'SUCCESS', moneyAmount: '0.001001' });

test('seller account identity comes from the session subject when shared keys omit userId', async (t) => {
  const accountId = '1234567890123456789';
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = [encode({ alg: 'synthetic' }), encode({ sub: accountId }), 'synthetic-signature'].join('.');
  const worker = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("test"); } };', d1Databases: ['DB'] });
  t.after(() => worker.dispose());
  const db = await worker.getD1Database('DB');
  await migrate(db);
  const calls = [];
  await connectSeller(db, encryptionKey, token, '', async (url, init) => {
    assert.equal(init.headers.Authorization, 'Bearer ' + token);
    calls.push(url);
    if (url.endsWith('/api/key/queryAllV2')) {
      return Response.json({ code: 0, data: { SHARED: [{ apiKeyId: '1', mask: masks[0] }] } });
    }
    assert.ok(url.endsWith('/uc/getUserInfo'));
    assert.deepEqual(JSON.parse(init.body), { userId: accountId });
    return Response.json({ code: 0, data: { walletInfo: { currency: 'USD' } } });
  });
  assert.deepEqual(calls, ['https://www.runninghub.ai/api/key/queryAllV2', 'https://www.runninghub.ai/uc/getUserInfo']);
  const saved = await db.prepare('SELECT encrypted_session FROM billing_connection WHERE id = 1').first();
  assert.ok(saved);
  assert.ok(!saved.encrypted_session.includes(token));
});

test('connecting the seller makes every current and future account key available without enrollment', async (t) => {
  const { outputFiles } = await build({
    stdin: { contents: `
      import * as seller from './app/api/seller/billing/route';
      import * as auth from './app/api/seller/auth/route';
      import { POST } from './app/api/allowance/route';
      export default { async fetch(req) {
        globalThis.testUser = req.headers.get('x-test-user');
        const path = new URL(req.url).pathname;
        return path === '/api/seller/auth' ? auth[req.method](req) : path === '/api/seller/billing' ? seller[req.method](req) : POST(req);
      } };
    `, resolveDir: siteRoot },
    absWorkingDir: siteRoot, bundle: true, format: 'esm', write: false,
    external: ['cloudflare:workers', 'node:*'], plugins: [{
      name: 'test-owner-identity', setup(builder) {
        builder.onResolve({ filter: /chatgpt-auth$/ }, () => ({ path: 'auth', namespace: 'synthetic' }));
        builder.onLoad({ filter: /.*/, namespace: 'synthetic' }, () => ({ contents: 'export async function getChatGPTUser() { return globalThis.testUser ? { userId: globalThis.testUser, email: globalThis.testUser === "owner-by-email" ? "owner@example.test" : "viewer@example.test" } : null; }' }));
      },
    }],
  });
  const roster = [
    { apiKeyId: '1', key: masks[0], createdAt: '2026-09-01T12:00:00.000Z', isSystemAuto: false },
    { apiKeyId: '2', key: masks[1], createdAt: '2026-09-02T12:00:00.000Z', isSystemAuto: false },
  ];
  const calls = [];
  const foreignKey = 'aaaa' + 'c'.repeat(24) + 'same';
  let expired = false, sibling = false, incompleteRoster = false;
  const worker = new Miniflare({
    modules: true, compatibilityDate: '2026-05-15', compatibilityFlags: ['nodejs_compat'], script: outputFiles[0].text,
    bindings: { KEYMETER_OWNER_ID: 'owner', KEYMETER_OWNER_EMAIL: 'owner@example.test', BILLING_ENCRYPTION_KEY: encryptionKey }, d1Databases: ['DB'],
    async outboundService(req) {
      const url = new URL(req.url);
      const body = req.method === 'POST' ? await req.json() : null;
      calls.push({ path: url.pathname, authorization: req.headers.get('authorization'), body });
      if (url.pathname === '/openapi/v2/api-key/list') {
        const submitted = req.headers.get('authorization').slice(7);
        const publicRoster = roster.map(row => ({
          key: (row.key ?? 'ssss****auto').replace(/\*+/, '********'),
          createdAt: submitted === foreignKey && row.apiKeyId === '1' ? '2026-09-01T12:00:01.000Z' : row.createdAt,
          quotaLimit: 20, quotaUsed: 1,
        }));
        return Response.json({ code: 0, data: incompleteRoster ? publicRoster.slice(0, 1) : publicRoster });
      }
      assert.equal(req.headers.get('authorization'), 'Bearer ' + sessionToken);
      if (expired) return Response.json({ code: 412, msg: sessionToken });
      if (url.pathname === '/api/key/queryAllV2') {
        return Response.json({ code: 0, data: { SHARED: roster.map(row => ({ apiKeyId: row.apiKeyId, mask: row.key ?? 'ssss****auto', userId: 99 })) } });
      }
      if (url.pathname === '/api/key/list') {
        assert.deepEqual(body, { type: 'SHARED' });
        return Response.json({ code: 0, data: roster });
      }
      if (url.pathname === '/uc/getUserInfo') return Response.json({ code: 0, data: { walletInfo: { currency: 'USD' } } });
      if (url.pathname === '/api/billing/usage/wideDetails') {
        assert.equal(body.apiKeyType, 2);
        assert.equal(body.size, 50);
        assert.equal(body.includeChildTasks, false);
        assert.match(body.startDateTime, /^\d{4}-\d{2}-\d{2} 00:00:00$/);
        return Response.json({ code: 0, data: { records: [record(sibling ? '2' : body.apiKeyId)], hasNext: false } });
      }
      assert.fail('Unexpected upstream endpoint ' + url.pathname);
    },
  });
  t.after(() => worker.dispose());
  const db = await worker.getD1Database('DB');
  await migrate(db);
  let ownerCookie = '';
  const seller = (method = 'GET', body, user = 'owner', origin = 'https://checker.test') => worker.dispatchFetch('https://checker.test/api/seller/billing', {
    method, headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}), origin, cookie: ownerCookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const customer = input => worker.dispatchFetch('https://checker.test/api/allowance', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: input }),
  });
  for (const method of ['GET', 'POST', 'DELETE']) {
    assert.equal((await seller(method, method === 'POST' ? { action: 'connect', sessionToken } : undefined, 'someone-else')).status, 403);
    assert.equal((await seller(method, method === 'POST' ? { action: 'connect', sessionToken } : undefined, null)).status, 403);
  }
  assert.equal((await seller('POST', { action: 'connect', sessionToken }, 'owner', 'https://other.test')).status, 403);
  assert.equal(calls.length, 0);
  assert.equal((await seller('GET', undefined, 'owner-by-email')).status, 401);
  const setup = await worker.dispatchFetch('https://checker.test/api/seller/auth', {
    method: 'POST', headers: { origin: 'https://checker.test', 'x-test-user': 'owner', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'setup', password: 'synthetic owner billing password' }),
  });
  assert.equal(setup.status, 200);
  ownerCookie = setup.headers.get('set-cookie').split(';')[0];
  assert.equal((await seller()).status, 200);
  assert.equal((await (await customer(key)).json()).tasks.state, 'not_connected');
  assert.equal(calls.length, 1);

  assert.equal((await seller('POST', { action: 'connect', sessionToken })).status, 200);
  const status = await (await seller()).json();
  assert.equal(status.connected, true);
  assert.equal(status.keyCount, 2);
  assert.ok(!JSON.stringify(status).includes(sessionToken));
  const ciphertext = (await db.prepare('SELECT encrypted_session FROM billing_connection').first()).encrypted_session;
  assert.ok(!ciphertext.includes(sessionToken));
  assert.ok(!ciphertext.includes('USD'));
  assert.equal((await seller('POST', { action: 'enroll', key, apiKeyId: '1' })).status, 400);

  const result = await (await customer(key)).json();
  assert.equal(result.tasks.state, 'ready');
  assert.deepEqual(result.tasks.records, [{ taskId: 'task-01', time: '2026-11-04T09:00:00.000Z', name: 'Synthetic model', status: 'SUCCESS', cost: 0.001001, currency: 'USD' }]);
  assert.equal((await (await customer(other)).json()).tasks.state, 'ready');
  assert.ok(!JSON.stringify(result).includes(sessionToken));
  assert.ok(!JSON.stringify(result).includes(key));
  assert.ok(!JSON.stringify(result).includes('apiKeyId'));
  assert.equal((await db.prepare('SELECT COUNT(*) AS total FROM billing_enrollment').first()).total, 0);

  const newKey = 'cccc' + 'd'.repeat(24) + 'new3';
  roster.push({ apiKeyId: '3', key: 'cccc****new3', createdAt: '2026-11-04T10:00:00.000Z', isSystemAuto: false });
  assert.equal((await (await customer(newKey)).json()).tasks.state, 'ready');
  assert.equal((await (await seller()).json()).keyCount, 3);

  const billRequests = () => calls.filter(call => call.path === '/api/billing/usage/wideDetails').length;
  const previousBills = billRequests();
  const foreignResult = await (await customer(foreignKey)).json();
  assert.equal(foreignResult.tasks.state, 'unavailable');
  assert.equal(foreignResult.remaining, 19);
  assert.equal(billRequests(), previousBills);
  incompleteRoster = true;
  assert.equal((await (await customer(key)).json()).tasks.state, 'unavailable');
  assert.equal(billRequests(), previousBills);
  incompleteRoster = false;

  roster.push({ apiKeyId: '4', key: null, createdAt: '2026-08-01T12:00:00.000Z', isSystemAuto: true });
  assert.equal((await (await customer(key)).json()).tasks.state, 'ready');
  const systemKey = 'ssss' + 's'.repeat(24) + 'auto';
  assert.equal((await (await customer(systemKey)).json()).tasks.state, 'ready');
  assert.equal((await (await seller()).json()).keyCount, 4);

  sibling = true;
  assert.equal((await (await customer(key)).json()).tasks.state, 'unavailable');
  sibling = false;
  expired = true;
  const expiredResult = await (await customer(key)).json();
  assert.equal(expiredResult.tasks.state, 'reconnect');
  assert.equal(expiredResult.remaining, 19);
  assert.equal((await (await seller()).json()).reconnect, true);
  assert.ok(!JSON.stringify(expiredResult).includes(sessionToken));
  expired = false;
  await seller('POST', { action: 'connect', sessionToken });
  const newCiphertext = (await db.prepare('SELECT encrypted_session FROM billing_connection').first()).encrypted_session;
  assert.notEqual(newCiphertext, ciphertext);
  assert.equal((await (await seller()).json()).keyCount, 4);
  assert.equal((await seller('DELETE')).status, 200);
  assert.equal((await db.prepare('SELECT COUNT(*) AS total FROM billing_enrollment').first()).total, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) AS total FROM billing_connection').first()).total, 0);
});

test('per-job projection rejects missing attribution, prevents duplicate child charges and keeps missing charges unknown', () => {
  const payload = records => ({ records, hasNext: false });
  assert.throws(() => projectTasks(payload([{ ...record(), apiKeyId: undefined }]), '1', 'USD'));
  assert.throws(() => projectTasks(payload([record('2')]), '1', 'USD'));
  assert.throws(() => projectTasks(payload([record(), record()]), '1', 'USD'));
  assert.equal(projectTasks(payload([{ ...record(), moneyAmount: undefined }]), '1', 'USD').records[0].cost, null);
  assert.equal(projectTasks(payload([{ ...record(), taskRelation: 'CHILD' }]), '1', 'USD').records.length, 0);
  const masked = { ...record(), apiKeyId: undefined, apiKey: masks[0] };
  assert.equal(projectTasks(payload([masked]), '1', 'USD', key, masks[0]).records.length, 1);
  assert.throws(() => projectTasks(payload([{ ...masked, apiKey: masks[1] }]), '1', 'USD', key, masks[0]));
});

test('empty per-job currency inherits the verified batch currency without inventing missing charges', () => {
  const payload = records => ({ records, hasNext: false, currency: 'USD' });
  for (const currency of [null, '']) {
    const zero = projectTasks(payload([{ ...record(), currency, moneyAmount: 0 }]), '1', 'EUR');
    assert.equal(zero.records[0].currency, 'USD', 'An empty row currency must use the verified batch currency.');
    assert.equal(zero.records[0].cost, 0, 'A reported zero is an actual zero charge.');
    const unknown = projectTasks(payload([{ ...record(), currency, moneyAmount: undefined }]), '1', 'EUR');
    assert.equal(unknown.records[0].currency, 'USD');
    assert.equal(unknown.records[0].cost, null, 'An omitted charge must stay unknown.');
  }
  assert.equal(projectTasks(payload([{ ...record(), currency: 'CNY' }]), '1', 'EUR').records[0].currency, 'CNY');
  for (const currency of ['usd', 'unknown', ' ', 'US', 5, {}, []])
    assert.throws(() => projectTasks(payload([{ ...record(), currency }]), '1', 'USD'));
  for (const currency of [null, '', 'usd', 'unknown', 5])
    assert.throws(() => projectTasks({ ...payload([{ ...record(), currency: null }]), currency }, '1', 'USD'),
      'An invalid batch currency must not be accepted because a row is empty.');
  assert.throws(() => projectTasks(payload([{ ...record('2'), currency: null }]), '1', 'USD'),
    'Currency fallback must not weaken key attribution.');
});

test('specific seller missing-token business errors request reconnection without misclassifying other forbidden errors', async () => {
  const db = { prepare() { assert.fail('A rejected seller session must not be saved.'); } };
  for (const msg of ['TOKEN_MISSION', 'TOKEN_INVALID']) {
    await assert.rejects(connectSeller(db, encryptionKey, sessionToken, '', async () => Response.json({ code: 403, msg })),
      error => error.status === 401 && /Reconnect/.test(error.message));
  }
  await assert.rejects(connectSeller(db, encryptionKey, sessionToken, '', async () => Response.json({ code: 403, msg: 'OTHER_FORBIDDEN_REASON' })),
    error => error.status === 502 && !/Reconnect/.test(error.message));
});

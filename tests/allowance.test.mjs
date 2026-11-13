import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL('../lib/quota.ts', import.meta.url))],
  bundle: true, format: 'esm', write: false });
const { projectAllowance, lookup } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
const key = 'abcd' + 'k'.repeat(24) + '9876',
  other = 'cdef' + 'z'.repeat(24) + '1234';
const row = {
  key: 'abcd*****9876',
  status: 1,
  quotaLimit: 20,
  quotaUsed: 15.152,
  expireAt: null,
};
test('projects just one authorized quota; does not leak wallet or other customers', async () => {
  let called = 0;
  const r = await lookup(key, {}, async (url, init) => {
    called++;
    assert.equal(url, 'https://www.runninghub.ai/openapi/v2/api-key/list');
    assert.equal(init.headers.Authorization, 'Bearer ' + key);
    return Response.json({
      code: 0,
      data: [{ ...row, key: other, apiKeyName: 'someone else' }, row],
      remainMoney: 43.7354,
    });
  });
  assert.equal(called, 1);
  assert.equal(r.remaining, 4.848);
  assert.equal(r.used, 15.152);
  assert.equal(r.limit, 20);
  assert.equal(r.state, 'reported');
  assert.deepEqual(
    Object.keys(r).sort(),
    ['checkedAt', 'limit', 'remaining', 'state', 'suffix', 'used'].sort(),
  );
});
test('missing or ambiguous key fails closed', () => {
  for (const rows of [
    [],
    [{ ...row, key: '****' }],
    [{ ...row, key: other }],
    [row, row],
  ])
    assert.throws(() => projectAllowance(rows, key));
});
test('rejects wallet data, absent/negative quota, malformed values', () => {
  for (const overrides of [
    { quotaUsed: null },
    { quotaLimit: undefined },
    { quotaUsed: ' ' },
    { quotaUsed: -1 },
    { quotaUsed: 'NaN' },
    { expireAt: '?' },
    { quotaLimit: '1e4' },
  ])
    assert.throws(() => projectAllowance([{ ...row, ...overrides }], key));
  assert.throws(() => projectAllowance({ remainMoney: '40' }, key));
});
test('zero, exhausted, over-limit, unspecified limit and expired remain distinct', () => {
  const q = (o) => projectAllowance([{ ...row, ...o }], key);
  assert.equal(q({ quotaLimit: 0, quotaUsed: 0 }).remaining, 0);
  assert.equal(q({ quotaUsed: 21 }).state, 'exhausted');
  assert.equal(q({ quotaUsed: 21 }).remaining, 0);
  assert.equal(q({ quotaLimit: null }).remaining, null);
  assert.equal(q({ status: 0 }).state, 'reported');
  assert.equal(q({ expireAt: '2000-01-01T00:00:00Z' }).state, 'expired');
});
test('no provider call for partial or masked input; no secrets in errors', async () => {
  await assert.rejects(
    lookup('abcd****9876', {}, () => assert.fail()),
    /full key/,
  );
  await assert.rejects(
    lookup(key, {}, async () => Response.json({ code: 1602, msg: key })),
    (e) => e.status === 422 && !e.message.includes(key),
  );
  await assert.rejects(
    lookup(key, {}, async () => new Response('limit', { status: 429 })),
    (e) => e.status === 429,
  );
});
test('direct key succeeds without using a stale enrolled owner credential', async () => {
  const { createHash } = await import('node:crypto');
  const cfg = {
    ownerKey: 'owner-secret-for-test',
    registered: createHash('sha256').update(key).digest('hex'),
  };
  for (const [input, expected] of [
    [key, key],
    [other, other],
  ]) {
    const r = await lookup(input, cfg, async (url, init) => {
      assert.equal(init.headers.Authorization, 'Bearer ' + expected);
      return Response.json({ code: 0, data: [row, { ...row, key: other }] });
    });
    assert.equal(r.suffix, input.slice(-4));
  }
});

test('owner fallback requires direct quota denial and exact full-key enrollment', async () => {
  const { createHash } = await import('node:crypto');
  const cfg = { ownerKey: 'synthetic-owner', registered: createHash('sha256').update(key).digest('hex') };
  const credentials = [];
  const result = await lookup(key, cfg, async (_url, init) => {
    credentials.push(init.headers.Authorization);
    return credentials.length === 1 ? new Response('', { status: 403 })
      : Response.json({ code: 0, data: [row] });
  });
  assert.equal(result.remaining, 4.848);
  assert.deepEqual(credentials, ['Bearer ' + key, 'Bearer ' + cfg.ownerKey]);
  let called = 0;
  await assert.rejects(lookup(other, cfg, async (_url, init) => {
    called++;
    assert.equal(init.headers.Authorization, 'Bearer ' + other);
    return new Response('', { status: 403 });
  }), error => error.status === 403);
  assert.equal(called, 1);
});

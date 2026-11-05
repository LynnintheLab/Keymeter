import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from './worker-fixture.mjs';
import { recordCheck } from '../lib/history.ts';

const siteRoot = fileURLToPath(new URL('../', import.meta.url));
const migrations = await Promise.all((await readdir(new URL('../drizzle/', import.meta.url))).filter(name => name.endsWith('.sql')).sort().map(name => readFile(new URL('../drizzle/' + name, import.meta.url), 'utf8')));
const key = 'synthetic-' + 'a'.repeat(20) + '-same';
const otherKey = key.replace('aaaaa', 'bbbbb');

test('quota history is available only after a successful lookup of that full key', async (t) => {
  const { outputFiles } = await build({
    stdin: { contents: "import { POST } from './app/api/allowance/route'; export default { fetch: POST };", resolveDir: siteRoot },
    absWorkingDir: siteRoot,
    bundle: true, format: 'esm', write: false, external: ['cloudflare:workers'],
  });
  let denied = false;
  let quotaUsed = '900000000.999999';
  const upstreamCalls = [];
  const worker = new Miniflare({
    modules: true, compatibilityDate: '2026-05-15', script: outputFiles[0].text,
    d1Databases: ['DB'],
    outboundService(req) {
      const submitted = req.headers.get('Authorization').slice('Bearer '.length);
      upstreamCalls.push(submitted);
      if (denied) return new Response(null, { status: 403 });
      return Response.json({ code: 0, data: [{ key: submitted, quotaUsed, quotaLimit: '900000001' }] });
    },
  });
  t.after(() => worker.dispose());
  const db = await worker.getD1Database('DB');
  const check = (input) => worker.dispatchFetch('https://checker.test/api/allowance', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: input }),
  });

  // Security limits require the database schema before any upstream request.
  const unavailable = await check(key);
  assert.equal(unavailable.status, 503);

  for (const migration of migrations) await db.batch(migration.split('--> statement-breakpoint').map(sql => db.prepare(sql)));
  const first = await (await check(key)).json();
  assert.deepEqual(first.history, [{
    checkedAt: first.checkedAt, used: 900000000.999999, remaining: 0.000001, change: null,
  }]);
  quotaUsed = '900000001';
  const second = await (await check(key)).json();
  assert.equal(second.history[0].change, 0.000001);
  assert.deepEqual(second.history[1], first.history[0]);
  quotaUsed = '0';
  const other = await (await check(otherKey)).json();
  assert.deepEqual(other.history, [{ checkedAt: other.checkedAt, used: 0, remaining: 900000001, change: null }]);

  denied = true;
  const revoked = await check(key);
  assert.equal(revoked.status, 403);
  assert.deepEqual(Object.keys(await revoked.json()), ['error']);
  assert.deepEqual(upstreamCalls, [key, key, otherKey, key]);
  const stored = (await db.prepare('SELECT * FROM quota_checks ORDER BY id').all()).results;
  assert.equal(stored.length, 3);
  assert.equal(stored[0].used_micros, 900000000999999);
  assert.equal(stored[0].remaining_micros, 1);
  assert.equal(stored[0].key_hash, stored[1].key_hash);
  assert.notEqual(stored[0].key_hash, stored[2].key_hash);
  assert.match(stored[0].key_hash, /^[a-f0-9]{64}$/);
  assert.notEqual(stored[0].key_hash, createHash('sha256').update(key).digest('hex'));
  assert.ok(!JSON.stringify(stored).includes(key.slice(-4)));

  await t.test('tied timestamps, pruning and usage resets keep exact deltas', async () => {
    const checkedAt = '2026-11-04T12:00:00.000Z';
    const retainedKey = 'synthetic-series-key'.padEnd(32, 'x');
    const sample = (i) => ({ checkedAt, used: i / 1_000_000, remaining: null, limit: null, state: 'reported', suffix: 'xxxx' });
    for (let i = 0; i <= 32; i++) await recordCheck(db, retainedKey, sample(i));
    const reset = await recordCheck(db, retainedKey, sample(1));
    assert.equal(reset.length, 30);
    assert.deepEqual(reset[0], { checkedAt, used: 0.000001, remaining: null, change: -0.000031 });
    assert.deepEqual(reset[29], { checkedAt, used: 0.000004, remaining: null, change: 0.000001 });
    const concurrent = await Promise.all([35, 36].map(i => recordCheck(db, retainedKey, sample(i))));
    for (const history of concurrent) {
      assert.equal(history.length, 30);
      assert.ok([0.000035, 0.000036].includes(history[0].used));
      assert.equal(history[0].change, (Math.round(history[0].used * 1e6) - Math.round(history[1].used * 1e6)) / 1e6);
    }
    const counts = await db.prepare('SELECT COUNT(*) AS total FROM quota_checks GROUP BY key_hash ORDER BY total').all();
    assert.deepEqual(counts.results.map(row => row.total), [1, 2, 31]);
  });
});

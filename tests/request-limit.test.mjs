import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { Miniflare } from './worker-fixture.mjs';
import { limitRequest } from '../lib/request-limit.ts';

test('request limits serialize concurrent checks, expire and never store raw keys or addresses', async (t) => {
  const worker = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("test"); } };', d1Databases: ['DB'] });
  t.after(() => worker.dispose());
  const db = await worker.getD1Database('DB');
  const directory = new URL('../drizzle/', import.meta.url);
  for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
    const sql = await readFile(new URL(name, directory), 'utf8');
    await db.batch(sql.split('--> statement-breakpoint').map(statement => db.prepare(statement)));
  }
  const now = Date.parse('2026-11-04T12:00:01Z');
  const request = new Request('https://checker.test/api/allowance', { headers: { 'cf-connecting-ip': '192.0.2.12' } });
  const outcomes = await Promise.all(Array.from({ length: 35 }, () =>
    limitRequest(request, db, 'allowance', 'synthetic-credential', now).then(() => true, error => {
      assert.equal(error.status, 429);
      assert.equal(error.retryAfter, 59);
      return false;
    })));
  assert.equal(outcomes.filter(Boolean).length, 30);
  await assert.rejects(limitRequest(new Request(request, { headers: { 'cf-connecting-ip': '192.0.2.13' } }), db, 'allowance', 'synthetic-credential', now), error => error.status === 429);
  const saved = await db.prepare('SELECT * FROM request_limits').all();
  assert.ok(!JSON.stringify(saved).includes('synthetic-credential'));
  assert.ok(!JSON.stringify(saved).includes('192.0.2.12'));
  assert.ok(saved.results.every(row => /^[a-f0-9]{64}$/.test(row.bucket_hash)));
  await limitRequest(request, db, 'allowance', 'synthetic-credential', now + 240_000);
  assert.equal((await db.prepare('SELECT COUNT(*) AS total FROM request_limits').first()).total, 2);
  await assert.rejects(limitRequest(request, undefined, 'allowance', 'synthetic-credential', now), error => error.status === 503);
});

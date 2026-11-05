import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { Miniflare } from './worker-fixture.mjs';

test('the actual Worker fetch reaches the quota endpoint and never follows redirects', async (t) => {
  const key = 'synthetic'.padEnd(32, 'x');
  const source = await readFile(new URL('../lib/quota.ts', import.meta.url), 'utf8');
  let upstream = 'ok';
  const requests = [];
  const worker = new Miniflare({
    modules: true, compatibilityDate: '2026-05-15',
    script: stripTypeScriptTypes(source, { mode: 'transform' }) + `
      export default { async fetch(req) {
        try { return Response.json(await lookup(await req.text())); }
        catch (e) { return Response.json({ error: e.message }, { status: e.status || 500 }); }
      } };
    `,
    outboundService(req) {
      requests.push([req.url, req.method, req.headers.get('authorization')]);
      if (upstream === 'redirect') return Response.redirect('https://other.invalid/no', 302);
      if (upstream === 'unknown') return Response.json({ code: 806, msg: 'APIKEY_USER_NOT_FOUND' });
      return Response.json({ code: 0, data: [{ key, quotaLimit: 20, quotaUsed: 15.152 }] });
    },
  });
  t.after(() => worker.dispose());
  const submit = () => worker.dispatchFetch('https://checker.test/', { method: 'POST', body: key });
  const ok = await submit();
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).remaining, 4.848);
  upstream = 'redirect';
  assert.equal((await submit()).status, 502);
  upstream = 'unknown';
  assert.equal((await submit()).status, 401);
  assert.deepEqual(requests, Array.from({ length: 3 }, () => [
    'https://www.runninghub.ai/openapi/v2/api-key/list', 'GET', 'Bearer ' + key
  ]));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createProviderFetch } from '../provider-fetch.mjs';

const QUOTA = 'https://www.runninghub.ai/openapi/v2/api-key/list';
const FALLBACK = '43.174.197.235';
const refused = () => Object.assign(new Error('private socket detail'), { code: 'ETIMEDOUT', retryable: true });

function harness(behaviour, { addresses = ['198.51.100.1'] } = {}) {
  const tried = [];
  const routed = createProviderFetch(
    async () => new Response('delegated', { status: 299 }),
    {
      resolver: { resolve4: async () => addresses },
      attempt: async (address, url, init, signal) => {
        tried.push(address);
        return behaviour(address, url, init, signal);
      },
    });
  return { routed, tried };
}

test('only the fixed provider origin is routed', async () => {
  const { routed, tried } = harness(async () => new Response('routed', { status: 200 }));
  for (const url of ['https://api.resend.com/domains', 'https://www.runninghub.ai.evil.test/x', 'https://runninghub.ai/']) {
    const response = await routed(url);
    assert.equal(response.status, 299, url);
  }
  assert.deepEqual(tried, []);
  assert.equal((await routed(QUOTA)).status, 200);
  assert.deepEqual(tried, ['198.51.100.1']);
});

test('a non-string body keeps the platform implementation', async () => {
  const { routed, tried } = harness(async () => new Response('routed', { status: 200 }));
  assert.equal((await routed(QUOTA, { method: 'POST', body: new Blob(['x']) })).status, 299);
  assert.deepEqual(tried, []);
  assert.equal((await routed(QUOTA, { method: 'POST', body: '{}' })).status, 200);
  assert.deepEqual(tried, ['198.51.100.1']);
});

test('an unreachable edge node fails over to a reachable one and is then remembered', async () => {
  const { routed, tried } = harness(async address => {
    if (address !== FALLBACK) throw refused();
    return new Response(JSON.stringify({ code: 0 }), { status: 200 });
  });
  const first = await routed(QUOTA, { headers: { Authorization: 'Bearer synthetic-test-value' } });
  assert.equal(first.status, 200);
  assert.deepEqual(tried, ['198.51.100.1', FALLBACK]);
  await routed(QUOTA);
  assert.deepEqual(tried, ['198.51.100.1', FALLBACK, FALLBACK], 'the working node is tried first next time');
});

test('credentials and method reach the chosen node unchanged and responses are not rewritten', async () => {
  let seen;
  const { routed } = harness(async (address, url, init) => {
    seen = { address, url, init };
    return new Response('', { status: 302, headers: { location: 'https://foreign.invalid/private' } });
  });
  const response = await routed(QUOTA, { method: 'GET', headers: { Authorization: 'Bearer synthetic-test-value' }, redirect: 'manual' });
  assert.equal(seen.url, QUOTA);
  assert.equal(seen.init.headers.Authorization, 'Bearer synthetic-test-value');
  assert.equal(response.status, 302, 'a redirect is returned, never followed');
  assert.equal(response.headers.get('location'), 'https://foreign.invalid/private');
});

test('a failure that is not a connection failure stops immediately', async () => {
  const { routed, tried } = harness(async () => { throw Object.assign(new Error('private detail'), { code: 'ECONNRESET', retryable: false }); });
  await assert.rejects(() => routed(QUOTA), /private detail/);
  assert.deepEqual(tried, ['198.51.100.1'], 'no second node is contacted after the request was already sent');
});

test('every candidate failing surfaces the last transport failure', async () => {
  const { routed, tried } = harness(async () => { throw refused(); });
  await assert.rejects(() => routed(QUOTA), error => error.code === 'ETIMEDOUT');
  assert.deepEqual(tried, ['198.51.100.1', FALLBACK, '43.174.196.235']);
});

test('an aborted request stops without contacting further nodes', async () => {
  const controller = new AbortController();
  const { routed, tried } = harness(async () => { controller.abort(); throw refused(); });
  await assert.rejects(() => routed(QUOTA, { signal: controller.signal }));
  assert.deepEqual(tried, ['198.51.100.1']);
});

test('an unresolvable hostname still reaches the known addresses', async () => {
  const { routed, tried } = harness(async address => {
    if (address !== FALLBACK) throw refused();
    return new Response('{}', { status: 200 });
  }, { addresses: [] });
  assert.equal((await routed(QUOTA)).status, 200);
  assert.deepEqual(tried, [FALLBACK]);
});

test('a node known to be unreachable is not retried first once the route expires', async () => {
  const tried = [];
  let clock = 1_000_000;
  const routed = createProviderFetch(async () => new Response('delegated', { status: 299 }), {
    now: () => clock,
    resolver: { resolve4: async () => ['198.51.100.1'] },
    attempt: async address => {
      tried.push(address);
      if (address !== FALLBACK) throw refused();
      return new Response('{}', { status: 200 });
    },
  });
  await routed(QUOTA);
  assert.deepEqual(tried, ['198.51.100.1', FALLBACK]);
  clock += 700_000; // past the remembered route, still inside the failure memory
  await routed(QUOTA);
  assert.deepEqual(tried, ['198.51.100.1', FALLBACK, FALLBACK], 'the unreachable node is ordered last');
  clock += 25_000_000; // the failure memory has expired, so the node is reconsidered
  await routed(QUOTA);
  assert.deepEqual(tried, ['198.51.100.1', FALLBACK, FALLBACK, '198.51.100.1', FALLBACK],
    'a node is reconsidered once its failure is old, and still falls back when it is dead');
});

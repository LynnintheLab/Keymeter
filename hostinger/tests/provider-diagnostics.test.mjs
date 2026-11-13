import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { probeDns, probeFetch, probeHttps, safeFailure } from '../diagnose-runninghub.mjs';

test('anonymous fetch diagnostics use only fixed endpoints and do not follow redirects', async () => {
  for (const target of ['quota', 'seller']) {
    const result = await probeFetch(target, async (url, init) => {
      assert.equal(url, 'https://www.runninghub.ai/' + (target === 'quota' ? 'openapi/v2/api-key/list' : 'api/key/queryAllV2'));
      assert.equal(init.redirect, 'manual');
      assert.equal(init.credentials, 'omit');
      assert.equal(init.headers.Authorization, undefined);
      assert.equal(init.body, target === 'seller' ? '{}' : undefined);
      assert.ok(init.signal instanceof AbortSignal);
      return Response.json({ code: target === 'quota' ? 1602 : 403,
        msg: target === 'quota' ? 'HEADER_API_KEY_NOT_FOUND' : 'TOKEN_MISSION', data: 'private synthetic body' });
    });
    assert.equal(result.status, 200);
    assert.ok(result.providerName);
    assert.doesNotMatch(JSON.stringify(result), /private synthetic body|https:/);
  }
  const redirect = await probeFetch('quota', async () => Response.redirect('https://foreign.invalid/private', 302));
  assert.equal(redirect.redirected, true);
  assert.doesNotMatch(JSON.stringify(redirect), /foreign/);
});

test('diagnostics bound bodies and never echo unknown provider errors or transport messages', async () => {
  const oversized = await probeFetch('quota', async () => new Response('x'.repeat(32769)));
  assert.deepEqual(oversized.codes, ['BODY_TOO_LARGE']);
  const unknown = await probeFetch('quota', async () => Response.json({ code: 987, msg: 'private token value' }));
  assert.equal(unknown.providerCode, '987');
  assert.equal(unknown.providerName, undefined);
  const failed = await probeFetch('quota', async () => { throw Object.assign(new TypeError('private token value'), { cause: Object.assign(new Error('private token value'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) }); });
  assert.deepEqual(failed.codes, ['UND_ERR_CONNECT_TIMEOUT']);
  assert.doesNotMatch(JSON.stringify([unknown, failed]), /private token/);
  assert.deepEqual(safeFailure({ name: 'private', code: 'private' }), { names: [], codes: [], kind: 'NETWORK_FAILURE' });
});

function syntheticHttps(status, body, inspect) {
  return (url, options, callback) => {
    inspect?.(url, options);
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = content => {
      assert.equal(content, undefined);
      queueMicrotask(() => {
        const response = Readable.from([Buffer.from(body)]);
        response.statusCode = status;
        callback(response);
      });
    };
    return req;
  };
}
test('native HTTPS diagnostics use no credentials, bound bodies and stop at redirects', async () => {
  const inspect = (url, options) => {
    assert.equal(url, 'https://www.runninghub.ai/openapi/v2/api-key/list');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, undefined);
  };
  const result = await probeHttps('quota', syntheticHttps(200, JSON.stringify({ code: 1602, msg: 'HEADER_API_KEY_NOT_FOUND' }), inspect));
  assert.equal(result.providerName, 'HEADER_API_KEY_NOT_FOUND');
  const redirect = await probeHttps('quota', syntheticHttps(302, 'private redirect body', inspect));
  assert.equal(redirect.redirected, true);
  const tooLarge = await probeHttps('quota', syntheticHttps(200, 'x'.repeat(32769), inspect));
  assert.deepEqual(tooLarge.codes, ['BODY_TOO_LARGE']);
});

test('DNS diagnostics keep valid addresses and recognized error codes only', async () => {
  const results = await probeDns({
    resolve4: async host => { assert.equal(host, 'www.runninghub.ai'); return ['127.0.0.1', 'private-secret']; },
    resolve6: async () => { throw Object.assign(new Error('private-secret'), { code: 'ENODATA' }); },
  });
  assert.deepEqual(results[0].addresses, ['127.0.0.1']);
  assert.deepEqual(results[1].codes, ['ENODATA']);
  assert.doesNotMatch(JSON.stringify(results), /private-secret/);
});

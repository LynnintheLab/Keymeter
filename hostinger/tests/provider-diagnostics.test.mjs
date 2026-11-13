import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { probeControl, probeDns, probeFetch, probeHttps, probeTcp, probeTls, safeFailure } from '../diagnose-runninghub.mjs';

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

function syntheticSocket(behavior) {
  const socket = new EventEmitter();
  socket.destroy = () => {};
  socket.connect = (options, onConnect) => queueMicrotask(() => behavior(socket, options, onConnect));
  return socket;
}

test('TCP diagnostics report reachability without echoing transport messages', async () => {
  const open = await probeTcp('203.0.113.7', 443, 1000, () => syntheticSocket((socket, options, onConnect) => {
    assert.equal(options.host, '203.0.113.7');
    assert.equal(options.port, 443);
    onConnect();
  }));
  assert.deepEqual(open, { transport: 'tcp', address: '203.0.113.7', family: 4, connected: true, elapsedMs: open.elapsedMs });
  const refused = await probeTcp('203.0.113.7', 443, 1000, () => syntheticSocket(socket =>
    socket.emit('error', Object.assign(new Error('private socket detail'), { code: 'ECONNREFUSED' }))));
  assert.deepEqual(refused.codes, ['ECONNREFUSED']);
  assert.equal(refused.connected, undefined);
  const dropped = await probeTcp('203.0.113.7', 443, 10, () => syntheticSocket(() => {}));
  assert.deepEqual(dropped.codes, ['ETIMEDOUT']);
  assert.doesNotMatch(JSON.stringify([refused, dropped]), /private socket detail/);
});

function syntheticTls(outcome) {
  return (options, onSecure) => {
    const socket = new EventEmitter();
    socket.destroy = () => {};
    socket.getProtocol = () => outcome.protocol;
    socket.authorized = outcome.authorized;
    socket.authorizationError = outcome.authorizationError;
    queueMicrotask(() => (outcome.error ? socket.emit('error', outcome.error) : onSecure()));
    return socket;
  };
}

test('TLS diagnostics verify the real hostname and keep only recognized labels', async () => {
  let seen;
  const verified = await probeTls('203.0.113.7', 'www.runninghub.ai', 1000, (options, onSecure) => {
    seen = options;
    return syntheticTls({ authorized: true, protocol: 'TLSv1.3' })(options, onSecure);
  });
  assert.equal(seen.servername, 'www.runninghub.ai');
  assert.equal(seen.port, 443);
  assert.equal(seen.headers, undefined);
  assert.deepEqual(verified, { transport: 'tls', address: '203.0.113.7', family: 4,
    connected: true, authorized: true, protocol: 'TLSv1.3', elapsedMs: verified.elapsedMs });
  const untrusted = await probeTls('203.0.113.7', 'www.runninghub.ai', 1000,
    syntheticTls({ authorized: false, protocol: 'TLSv1.2', authorizationError: Object.assign(new Error('private chain detail'), { code: 'CERT_HAS_EXPIRED' }) }));
  assert.equal(untrusted.authorized, false);
  assert.deepEqual(untrusted.codes, ['CERT_HAS_EXPIRED']);
  const rejected = await probeTls('203.0.113.7', 'www.runninghub.ai', 1000,
    syntheticTls({ error: Object.assign(new Error('private chain detail'), { code: 'ECONNRESET' }) }));
  assert.deepEqual(rejected.codes, ['ECONNRESET']);
  assert.equal(await probeTls('203.0.113.7', 'www.runninghub.ai', 10, () => {
    const socket = new EventEmitter();
    socket.destroy = () => {};
    return socket;
  }).then(result => result.codes[0]), 'ETIMEDOUT');
  assert.doesNotMatch(JSON.stringify([untrusted, rejected]), /private chain detail/);
});

test('control destinations are fixed, credential-free and reveal only bounded trace facts', async () => {
  await assert.rejects(() => probeControl('attacker-supplied'), /Unknown control destination/);
  const requested = [];
  for (const name of ['apex', 'mail']) {
    const result = await probeControl(name, async (url, init) => {
      requested.push(url);
      assert.equal(init.redirect, 'manual');
      assert.equal(init.credentials, 'omit');
      assert.equal(init.headers.Authorization, undefined);
      assert.equal(init.body, undefined);
      return new Response('private control body', { status: 401 });
    });
    assert.equal(result.status, 401);
    assert.equal(result.transport, 'control');
    assert.doesNotMatch(JSON.stringify(result), /private control body/);
  }
  assert.deepEqual(requested, ['https://runninghub.ai/', 'https://api.resend.com/domains']);
  const trace = await probeControl('trace', async () =>
    new Response('fl=22x1\nip=203.0.113.9\ncolo=AMS\nuag=private agent string\n', { status: 200 }));
  assert.equal(trace.egressAddress, '203.0.113.9');
  assert.equal(trace.egressColo, 'AMS');
  assert.doesNotMatch(JSON.stringify(trace), /private agent string|fl=/);
});

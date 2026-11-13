import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL('../lib/provider-diagnostics.ts', import.meta.url))],
  bundle: true, format: 'esm', write: false });
const { providerNetworkFailure } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

test('provider network diagnostics log only recognized labels, including nested causes', () => {
  const messages = [], original = console.warn;
  console.warn = (...values) => messages.push(values.join(' '));
  try {
    const secret = 'synthetic-private-token-and-provider-body';
    const root = Object.assign(new TypeError(secret), {
      cause: new AggregateError([
        Object.assign(new Error(secret), { code: 'ECONNRESET', request: { Authorization: secret } }),
        Object.assign(new Error(secret), { code: secret }),
      ], secret),
      url: 'https://provider.invalid/?key=' + secret,
    });
    providerNetworkFailure('billing', root);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /billing/);
    assert.match(messages[0], /TypeError/);
    assert.match(messages[0], /ECONNRESET/);
    assert.doesNotMatch(messages[0], /synthetic-private|Authorization|provider\.invalid|stack|message/);
    providerNetworkFailure('quota', { name: secret, code: secret, message: secret });
    assert.match(messages[1], /NETWORK_FAILURE/);
    assert.doesNotMatch(messages[1], /synthetic-private/);
  } finally { console.warn = original; }
});

test('diagnostic logging does not throw if the logger fails or the cause is cyclic', () => {
  const original = console.warn;
  console.warn = () => { throw new Error('logger failure'); };
  try {
    const cyclic = new Error('private'); cyclic.cause = cyclic;
    assert.doesNotThrow(() => providerNetworkFailure('quota', cyclic));
  } finally { console.warn = original; }
});

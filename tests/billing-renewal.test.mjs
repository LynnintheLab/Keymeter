import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from './worker-fixture.mjs';

const bundle = await build({ entryPoints: [fileURLToPath(new URL('../lib/billing.ts', import.meta.url))], bundle: true, format: 'esm', write: false });
const { connectSeller, addSellerRefreshToken, sellerStatus, disconnectSeller, projectTasks } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const encryptionKey = randomBytes(32).toString('base64');
const refresh = 'synthetic-refresh-token-original';
const rotatedRefresh = 'synthetic-refresh-token-rotated';
const token = (seconds, sub = '1234567890123456789') => ['synthetic', Buffer.from(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + seconds })).toString('base64url'), 'signature'].join('.');
const keys = { SHARED: [{ apiKeyId: 'one', mask: 'abcd****1234' }] };

async function database(t) {
  const worker = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("test"); } };', d1Databases: ['DB'] });
  t.after(() => worker.dispose());
  const db = await worker.getD1Database('DB');
  for (const migration of ['0001_jittery_vindicator.sql', '0002_loving_bushwacker.sql']) {
    const sql = await readFile(new URL('../drizzle/' + migration, import.meta.url), 'utf8');
    await db.batch(sql.split('--> statement-breakpoint').map(statement => db.prepare(statement)));
  }
  return db;
}
function transportFor(onRequest) {
  return async (url, init) => {
    const result = await onRequest?.(url, init);
    if (result) return result;
    if (url.endsWith('/api/key/queryAllV2')) return Response.json({ code: 0, data: keys });
    if (url.endsWith('/uc/getUserInfo')) return Response.json({ code: 0, data: { walletInfo: { currency: 'USD' } } });
    assert.fail('Unexpected provider operation');
  };
}
const stored = db => db.prepare('SELECT * FROM billing_connection WHERE id = 1').first();
async function decrypted(ciphertext) {
  const [iv, data] = ciphertext.split('.').map(value => Buffer.from(value, 'base64'));
  const secret = await crypto.subtle.importKey('raw', Buffer.from(encryptionKey, 'base64'), 'AES-GCM', false, ['decrypt']);
  return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv,
    additionalData: new TextEncoder().encode('keymeter:billing-session:v1') }, secret, data)));
}

test('access-only connections survive repeated visits and never persist plaintext credentials', async t => {
  const db = await database(t);
  const access = token(3600);
  await connectSeller(db, encryptionKey, access, '', transportFor());
  const first = await stored(db);
  for (let i = 0; i < 2; i++) {
    const status = await sellerStatus(db, encryptionKey, transportFor());
    assert.equal(status.connected, true);
    assert.equal(status.canRenew, false);
    assert.equal(status.expiresAt, new Date(JSON.parse(Buffer.from(access.split('.')[1], 'base64url')).exp * 1000).toISOString());
  }
  assert.equal((await stored(db)).encrypted_session, first.encrypted_session);
  assert.ok(!first.encrypted_session.includes(access));
});

test('near-expiry sessions renew once, save rotated credentials encrypted, and reuse them later', async t => {
  const db = await database(t);
  const access = token(60), replacement = token(7200);
  let refreshCalls = 0;
  const transport = transportFor((url, init) => {
    if (url.endsWith('/uc/token/refresh')) {
      refreshCalls++;
      assert.equal(init.headers.Authorization, 'Bearer ' + refresh);
      assert.equal(init.body, '{}');
      return Response.json({ code: 0, data: { access_token: replacement, refresh_token: rotatedRefresh, expire_in: 7200000 } });
    }
  });
  await connectSeller(db, encryptionKey, access, '', transport, refresh);
  const before = (await stored(db)).encrypted_session;
  const status = await sellerStatus(db, encryptionKey, transport);
  assert.equal(status.connected, true);
  assert.equal(status.canRenew, true);
  const saved = await stored(db);
  assert.notEqual(saved.encrypted_session, before);
  assert.equal(saved.refresh_lock_until, 0);
  assert.equal((await decrypted(saved.encrypted_session)).refreshToken, rotatedRefresh);
  assert.equal((await decrypted(saved.encrypted_session)).token, replacement);
  await sellerStatus(db, encryptionKey, transport);
  assert.equal(refreshCalls, 1);
  assert.equal((await stored(db)).encrypted_session, saved.encrypted_session);
});

test('transient early-renewal failure preserves a working session and backs off further renewals', async t => {
  const db = await database(t);
  let attempts = 0;
  const transport = transportFor(url => {
    if (url.endsWith('/uc/token/refresh')) { attempts++; return new Response(null, { status: 503 }); }
  });
  await connectSeller(db, encryptionKey, token(60), '', transport, refresh);
  const before = (await stored(db)).encrypted_session;
  assert.equal((await sellerStatus(db, encryptionKey, transport)).connected, true);
  assert.equal((await sellerStatus(db, encryptionKey, transport)).connected, true);
  assert.equal(attempts, 1);
  assert.equal((await stored(db)).encrypted_session, before);
});

test('provider rejection refreshes and retries only once, then asks for reconnection if still rejected', async t => {
  const db = await database(t);
  let reject = false, refreshCalls = 0;
  const transport = transportFor(url => {
    if (url.endsWith('/uc/token/refresh')) { refreshCalls++; return Response.json({ code: 0, data: { access_token: token(3600), refresh_token: rotatedRefresh } }); }
    if (reject && url.endsWith('/api/key/queryAllV2')) return Response.json({ code: 412 });
  });
  await connectSeller(db, encryptionKey, token(3600), '', transport, refresh);
  reject = true;
  const status = await sellerStatus(db, encryptionKey, transport);
  assert.equal(status.reconnect, true);
  assert.equal(refreshCalls, 1);
  assert.ok(await stored(db));
});

test('concurrent expiry checks cause one rotation and an in-flight refresh cannot restore a disconnected account', async t => {
  const db = await database(t);
  let release;
  let start;
  const started = new Promise(resolve => { start = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  let refreshCalls = 0;
  const transport = transportFor(async url => {
    if (url.endsWith('/uc/token/refresh')) {
      refreshCalls++; start(); await waiting;
      return Response.json({ code: 0, data: { access_token: token(3600), refresh_token: rotatedRefresh } });
    }
  });
  await connectSeller(db, encryptionKey, token(-60), '', transport, refresh);
  const first = sellerStatus(db, encryptionKey, transport);
  await started;
  const during = await sellerStatus(db, encryptionKey, transport);
  assert.equal(during.connected, true);
  assert.equal(during.unavailable, true);
  assert.equal(refreshCalls, 1);
  await disconnectSeller(db);
  release();
  await first;
  assert.equal(await stored(db), null);
});

test('manual reconnection wins over a pending refresh and transient outages keep saved-session status', async t => {
  const db = await database(t);
  let release, start;
  const started = new Promise(resolve => { start = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const replacement = token(10800);
  const transport = transportFor(async url => {
    if (url.endsWith('/uc/token/refresh')) {
      start(); await waiting;
      return Response.json({ code: 0, data: { access_token: token(3600), refresh_token: rotatedRefresh } });
    }
  });
  await connectSeller(db, encryptionKey, token(-60), '', transport, refresh);
  const pending = sellerStatus(db, encryptionKey, transport);
  await started;
  await connectSeller(db, encryptionKey, replacement, '', transportFor());
  release(); await pending;
  assert.equal((await decrypted((await stored(db)).encrypted_session)).token, replacement);
  const outage = await sellerStatus(db, encryptionKey, transportFor(() => new Response(null, { status: 503 })));
  assert.equal(outage.connected, true);
  assert.equal(outage.unavailable, true);
  assert.equal((await decrypted((await stored(db)).encrypted_session)).token, replacement);
});

test('a concurrent early renewal reuses the winning token instead of showing a false reconnect', async t => {
  const db = await database(t);
  const access = token(60), replacement = token(7200);
  let release, start, oldQueryStarted;
  const started = new Promise(resolve => { start = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const oldQuery = new Promise(resolve => { oldQueryStarted = resolve; });
  let active = access;
  let renewing = false;
  const transport = transportFor(async (url, init) => {
    if (url.endsWith('/uc/token/refresh')) {
      renewing = true; start(); await waiting; active = replacement;
      return Response.json({ code: 0, data: { access_token: replacement, refresh_token: rotatedRefresh } });
    }
    if (renewing && url.endsWith('/api/key/queryAllV2') && init.headers.Authorization === 'Bearer ' + access) {
      oldQueryStarted(); await waiting;
      await new Promise(resolve => setTimeout(resolve, 30));
      return Response.json({ code: 412 });
    }
    if (url.endsWith('/api/key/queryAllV2')) assert.equal(init.headers.Authorization, 'Bearer ' + active);
  });
  await connectSeller(db, encryptionKey, access, '', transport, refresh);
  const first = sellerStatus(db, encryptionKey, transport);
  await started;
  const second = sellerStatus(db, encryptionKey, transport);
  await oldQuery;
  release();
  for (const result of await Promise.all([first, second])) {
    assert.equal(result.connected, true);
    assert.ok(!result.reconnect);
  }
});

test('reported billing and historical row currencies take precedence over the saved connection', () => {
  const row = { apiKeyId: 'one', taskId: 'synthetic-task', createTime: '2026-11-04T10:00:00Z', moneyAmount: '0.01' };
  const payload = { records: [row], hasNext: false, currency: 'EUR' };
  assert.equal(projectTasks(payload, 'one', 'USD').records[0].currency, 'EUR');
  assert.equal(projectTasks({ ...payload, records: [{ ...row, currency: 'CNY' }] }, 'one', 'USD').records[0].currency, 'CNY');
  for (const currency of [null, 'usd', 'unknown', 5]) {
    assert.throws(() => projectTasks({ ...payload, currency }, 'one', 'USD'));
  }
  for (const currency of ['usd', 'unknown', 5]) {
    assert.throws(() => projectTasks({ ...payload, records: [{ ...row, currency }] }, 'one', 'USD'));
  }
});

test('an existing saved account can enable renewal with only its refresh token', async t => {
  const db = await database(t);
  const access = token(3600), replacement = token(7200);
  let refreshCalls = 0;
  const transport = transportFor((url, init) => {
    if (url.endsWith('/uc/token/refresh')) {
      refreshCalls++;
      assert.equal(init.headers.Authorization, 'Bearer ' + refresh);
      return Response.json({ code: 0, data: { access_token: replacement, refresh_token: rotatedRefresh, expire_in: 7200000 } });
    }
  });
  await connectSeller(db, encryptionKey, access, '', transportFor());
  const original = await stored(db);
  await addSellerRefreshToken(db, encryptionKey, refresh, transport);
  const saved = await stored(db);
  assert.notEqual(saved.encrypted_session, original.encrypted_session);
  assert.equal(saved.refresh_lock_until, 0);
  const credentials = await decrypted(saved.encrypted_session);
  assert.equal(credentials.token, replacement);
  assert.equal(credentials.refreshToken, rotatedRefresh);
  assert.ok(!saved.encrypted_session.includes(refresh));
  assert.equal((await sellerStatus(db, encryptionKey, transport)).canRenew, true);
  assert.equal(refreshCalls, 1);
});

test('renewal attachment rejects a foreign roster or subject and provider failures without replacing the account', async t => {
  const db = await database(t);
  const access = token(3600), replacement = token(7200);
  await connectSeller(db, encryptionKey, access, '', transportFor());
  const original = (await stored(db)).encrypted_session;
  for (const mode of ['roster', 'subject', 'unavailable', 'rejected']) {
    const renewed = mode === 'subject' ? token(7200, '9876543210987654321') : replacement;
    const transport = transportFor((url, init) => {
      if (url.endsWith('/uc/token/refresh')) {
        if (mode === 'unavailable') return new Response(null, { status: 503 });
        if (mode === 'rejected') return Response.json({ code: 412 });
        return Response.json({ code: 0, data: { access_token: renewed, refresh_token: rotatedRefresh } });
      }
      if (url.endsWith('/api/key/queryAllV2') && init.headers.Authorization === 'Bearer ' + renewed && mode === 'roster')
        return Response.json({ code: 0, data: { SHARED: [{ apiKeyId: 'foreign', mask: 'abcd****1234' }] } });
    });
    await assert.rejects(addSellerRefreshToken(db, encryptionKey, refresh, transport));
    const saved = await stored(db);
    assert.equal(saved.encrypted_session, original, mode);
    assert.equal(saved.refresh_lock_until, 0, mode);
  }
  await assert.rejects(addSellerRefreshToken(db, encryptionKey, '', transportFor()));
  assert.equal((await stored(db)).encrypted_session, original);
});

test('manual replacement and disconnect win over an in-flight renewal attachment', async t => {
  for (const action of ['replace', 'disconnect']) {
    const db = await database(t);
    let release, start;
    const started = new Promise(resolve => { start = resolve; });
    const waiting = new Promise(resolve => { release = resolve; });
    const refreshedAccess = token(7200), manualAccess = token(10800);
    const transport = transportFor(async url => {
      if (url.endsWith('/uc/token/refresh')) {
        start(); await waiting;
        return Response.json({ code: 0, data: { access_token: refreshedAccess, refresh_token: rotatedRefresh } });
      }
    });
    await connectSeller(db, encryptionKey, token(3600), '', transportFor());
    const pending = addSellerRefreshToken(db, encryptionKey, refresh, transport);
    const outcome = pending.then(() => null, error => error);
    await started;
    if (action === 'replace') await connectSeller(db, encryptionKey, manualAccess, '', transportFor());
    else await disconnectSeller(db);
    release();
    assert.ok(await outcome, action + ' must supersede the attachment');
    const saved = await stored(db);
    if (action === 'replace') {
      const credentials = await decrypted(saved.encrypted_session);
      assert.equal(credentials.token, manualAccess);
      assert.equal(credentials.refreshToken, undefined);
    } else assert.equal(saved, null);
  }
});

test('a transient credential-save error retries the same rotation once, including an uncertain successful write', async t => {
  for (const afterWrite of [false, true]) {
    const db = await database(t);
    await connectSeller(db, encryptionKey, token(3600), '', transportFor());
    let saveAttempts = 0, refreshCalls = 0;
    const replacement = token(7200);
    const flaky = {
      prepare(sql) {
        const wrap = statement => ({
          bind(...values) { return wrap(statement.bind(...values)); },
          first(...values) { return statement.first(...values); },
          async run() {
            if (/UPDATE billing_connection SET encrypted_session/.test(sql)) {
              saveAttempts++;
              if (saveAttempts === 1) {
                if (afterWrite) await statement.run();
                throw new Error('Synthetic transient persistence error');
              }
            }
            return statement.run();
          },
        });
        return wrap(db.prepare(sql));
      },
    };
    const transport = transportFor(url => {
      if (url.endsWith('/uc/token/refresh')) {
        refreshCalls++;
        return Response.json({ code: 0, data: { access_token: replacement, refresh_token: rotatedRefresh } });
      }
    });
    await addSellerRefreshToken(flaky, encryptionKey, refresh, transport);
    assert.equal(saveAttempts, 2);
    assert.equal(refreshCalls, 1);
    const saved = await decrypted((await stored(db)).encrypted_session);
    assert.equal(saved.token, replacement);
    assert.equal(saved.refreshToken, rotatedRefresh);
  }
});

test('an opaque rotated token does not inherit an old expiry and trigger repeated early refreshes', async t => {
  const db = await database(t);
  let refreshCalls = 0;
  const transport = transportFor(url => {
    if (url.endsWith('/api/key/queryAllV2'))
      return Response.json({ code: 0, data: { SHARED: [{ ...keys.SHARED[0], userId: '1234567890123456789' }] } });
    if (url.endsWith('/uc/token/refresh')) {
      refreshCalls++;
      return Response.json({ code: 0, data: { access_token: 'synthetic-opaque-access-renewed-' + refreshCalls, refresh_token: rotatedRefresh,
        ...(refreshCalls === 1 ? { expire_in: 1 } : {}) } });
    }
  });
  await connectSeller(db, encryptionKey, token(-60), '', transport, refresh);
  await sellerStatus(db, encryptionKey, transport);
  await sellerStatus(db, encryptionKey, transport);
  await sellerStatus(db, encryptionKey, transport);
  assert.equal(refreshCalls, 2);
  assert.equal((await sellerStatus(db, encryptionKey, transport)).expiresAt, null);
});

test('renewal attachment preserves the selected team and rejects another team wallet', async t => {
  for (const mismatch of [false, true]) {
    const db = await database(t);
    const access = token(3600), replacement = token(7200);
    const transport = transportFor((url, init) => {
      if (url.endsWith('/uc/token/refresh'))
        return Response.json({ code: 0, data: { access_token: replacement, refresh_token: rotatedRefresh } });
      if (url.includes('/uc/team/wallet/current-subject-balance')) {
        assert.equal(new URL(url).searchParams.get('teamId'), 'synthetic-team');
        assert.equal(init.headers['X-Team-Id'], 'synthetic-team');
        assert.equal(init.method, 'GET');
        const isReplacement = init.headers.Authorization === 'Bearer ' + replacement;
        return Response.json({ code: 0, data: { teamId: mismatch && isReplacement ? 'foreign-team' : 'synthetic-team', currency: 'USD' } });
      }
    });
    await connectSeller(db, encryptionKey, access, 'synthetic-team', transport);
    const original = (await stored(db)).encrypted_session;
    if (mismatch) {
      await assert.rejects(addSellerRefreshToken(db, encryptionKey, refresh, transport));
      assert.equal((await stored(db)).encrypted_session, original);
    } else {
      await addSellerRefreshToken(db, encryptionKey, refresh, transport);
      const saved = await decrypted((await stored(db)).encrypted_session);
      assert.equal(saved.teamId, 'synthetic-team');
      assert.equal(saved.token, replacement);
    }
  }
});

test('refresh-only recovery of expired access requires its trusted stored subject and matching currency', async t => {
  for (const mode of ['same', 'foreign', 'currency', 'subjectless']) {
    const db = await database(t);
    const access = mode === 'subjectless' ? 'synthetic-opaque-original-access' : token(-60);
    const replacement = token(7200, mode === 'foreign' ? '9876543210987654321' : '1234567890123456789');
    let rejectOld = false, refreshCalls = 0;
    const transport = transportFor((url, init) => {
      if (url.endsWith('/api/key/queryAllV2')) {
        if (rejectOld && init.headers.Authorization === 'Bearer ' + access) return Response.json({ code: 412 });
        // Opaque original sessions may be validated initially through provider IDs.
        return Response.json({ code: 0, data: { SHARED: [{ apiKeyId: 'one', mask: 'abcd****1234', userId: '1234567890123456789' }] } });
      }
      if (url.endsWith('/uc/token/refresh')) {
        refreshCalls++;
        return Response.json({ code: 0, data: { access_token: replacement, refresh_token: rotatedRefresh } });
      }
      if (url.endsWith('/uc/getUserInfo')) {
        const currency = rejectOld && mode === 'currency' ? 'EUR' : 'USD';
        return Response.json({ code: 0, data: { walletInfo: { currency } } });
      }
    });
    await connectSeller(db, encryptionKey, access, '', transport);
    const original = (await stored(db)).encrypted_session;
    rejectOld = true;
    if (mode === 'same') {
      await addSellerRefreshToken(db, encryptionKey, refresh, transport);
      assert.equal((await decrypted((await stored(db)).encrypted_session)).token, replacement);
      assert.equal((await sellerStatus(db, encryptionKey, transport)).canRenew, true);
    } else {
      await assert.rejects(addSellerRefreshToken(db, encryptionKey, refresh, transport));
      assert.equal((await stored(db)).encrypted_session, original, mode);
    }
    assert.equal(refreshCalls, mode === 'subjectless' ? 0 : 1, mode);
  }
});

test('automatic renewal rejects a refresh token for another seller before replacing stored credentials', async t => {
  const db = await database(t);
  const access = token(-60), foreign = token(7200, '9876543210987654321');
  const transport = transportFor(url => {
    if (url.endsWith('/uc/token/refresh'))
      return Response.json({ code: 0, data: { access_token: foreign, refresh_token: rotatedRefresh } });
  });
  await connectSeller(db, encryptionKey, access, '', transport, refresh);
  const original = (await stored(db)).encrypted_session;
  const status = await sellerStatus(db, encryptionKey, transport);
  assert.equal(status.reconnect, true);
  assert.equal((await stored(db)).encrypted_session, original);
});

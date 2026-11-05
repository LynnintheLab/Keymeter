import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';
import { database, closeDatabase, getPool, migrateDatabase } from '../database.mjs';
import { configProblems } from '../config.mjs';
import { passwordHash, verifyPassword, sanitizedHeaders, cookieHeader, checkLogin, createFormProtection, FORM_TTL } from '../security.mjs';
import { beginEmailChallenge, verifyEmailChallenge, emailChallenge, resendEmailChallenge, verifyEmailChange, sendLoginCode, CODE_TTL } from '../email-auth.mjs';
import { ownerAccount, authenticatedOwner, REMEMBER_TTL } from '../security.mjs';
import { createGateway } from '../gateway.mjs';

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}
const sleep = duration => new Promise(resolve => setTimeout(resolve, duration));

async function browserForm(origin, path, cookie = '') {
  const response = await fetch(origin + path, { headers: { cookie }, redirect: 'manual' });
  assert.equal(response.status, 200);
  const html = await response.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(csrf, 'Every owner HTML form must carry a signed form proof.');
  assert.equal((html.match(/<form /g) || []).length, (html.match(/name="csrf"/g) || []).length);
  const cookies = new Map(cookie.split(';').map(value => value.trim()).filter(Boolean).map(value => [value.split('=')[0], value]));
  for (const value of response.headers.getSetCookie()) cookies.set(value.split('=')[0], value.split(';')[0]);
  return { csrf, cookie: [...cookies.values()].join('; '), html };
}
async function submitForm(origin, path, fields, cookie = '', options = {}) {
  const proof = await browserForm(origin, options.page || '/login', cookie);
  return fetch(origin + path, { method: 'POST', headers: { ...(options.origin === null ? {} : { origin: options.origin || origin }), cookie: proof.cookie,
    'content-type': 'application/x-www-form-urlencoded', ...options.headers }, body: new URLSearchParams({ ...fields, csrf: proof.csrf }), redirect: 'manual' });
}

test('standalone owner authentication and MySQL compatibility', async t => {
  const password = 'synthetic-owner-password-for-tests';
  Object.assign(process.env, {
    APP_URL: 'http://127.0.0.1:3000', DB_HOST: '127.0.0.1', DB_NAME: 'keymeter_test', DB_USER: 'root', DB_PASSWORD: 'synthetic-test-db-password',
    RESEND_API_KEY: 're_synthetic-test-key', AUTH_EMAIL_FROM: 'Keymeter <auth@example.test>',
    ADMIN_EMAIL: 'owner@example.test', ADMIN_PASSWORD_HASH: await passwordHash(password),
    SESSION_SECRET: randomBytes(32).toString('base64url'), BILLING_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  });
  assert.deepEqual(configProblems(), []);
  assert.equal(await verifyPassword(password, process.env.ADMIN_PASSWORD_HASH), true);
  assert.equal(await verifyPassword('wrong-password', process.env.ADMIN_PASSWORD_HASH), false);
  const sanitized = sanitizedHeaders({ 'oai-authenticated-user-email': 'owner@example.test', 'oai-authenticated-user-id': 'fake',
    'OAI-Sites-Authorization': 'fake', 'cf-connecting-ip': 'spoof', 'x-keymeter-client-ip': 'spoof', 'x-forwarded-proto': 'http', 'x-forwarded-host': 'evil.test' }, '127.0.0.2', null);
  assert.ok(!Object.keys(sanitized).some(name => name.startsWith('oai-')));
  assert.equal(sanitized['x-keymeter-client-ip'], '127.0.0.2');
  assert.equal(sanitized['cf-connecting-ip'], undefined);
  process.env.APP_URL = 'https://keys.example.test';
  assert.match(cookieHeader('synthetic'), /__Host-keymeter-session=.*HttpOnly; SameSite=Strict.*Secure/);

  const internal = createServer((request, response) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(request.headers)); });
  const internalPort = await listen(internal);
  const gatewayProbe = createServer();
  const gatewayPort = await listen(gatewayProbe);
  await new Promise(resolve => gatewayProbe.close(resolve));
  const origin = 'http://127.0.0.1:' + gatewayPort;
  process.env.APP_URL = origin;
  const delivered = [];
  const emailTransport = async (url, init) => {
    assert.equal(url, 'https://api.resend.com/emails');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    delivered.push(JSON.parse(init.body));
    return Response.json({ id: 'synthetic-message-id' });
  };
  const latestCode = () => /code is (\d{6})/.exec(delivered.at(-1).text)[1];
  const gateway = createGateway(internalPort, { emailTransport });
  await new Promise(resolve => gateway.listen(gatewayPort, '127.0.0.1', resolve));
  t.after(() => Promise.all([new Promise(resolve => internal.close(resolve)), new Promise(resolve => gateway.close(resolve))]));
  const spoof = { 'oai-authenticated-user-id': 'hostinger-owner', 'oai-authenticated-user-email': 'owner@example.test', 'cf-connecting-ip': 'spoof', 'x-keymeter-client-ip': 'spoof' };
  assert.equal((await fetch(origin + '/api/seller/billing', { headers: spoof })).status, 403);
  const protectedPage = await fetch(origin + '/seller', { headers: spoof, redirect: 'manual' });
  assert.equal(protectedPage.status, 303);
  assert.equal(protectedPage.headers.get('location'), origin + '/login');
  const forwarded = await (await fetch(origin + '/api/allowance', { headers: spoof })).json();
  assert.equal(forwarded['oai-authenticated-user-id'], undefined);
  assert.equal(forwarded['cf-connecting-ip'], undefined);
  assert.equal(forwarded['x-keymeter-client-ip'], '127.0.0.1');
  assert.equal((await fetch(origin + '/login', { method: 'POST', headers: { origin: 'https://evil.test', 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=owner@example.test&password=synthetic' })).status, 403);

  if (spawnSync('mariadb-install-db', ['--help'], { stdio: 'ignore' }).error) {
    t.diagnostic('Disposable MariaDB integration skipped because mariadb-install-db is unavailable.');
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'keymeter-mysql-test-'));
  const initialized = spawnSync('mariadb-install-db', ['--no-defaults', '--datadir=' + directory, '--auth-root-authentication-method=normal', '--skip-test-db'], { encoding: 'utf8' });
  assert.equal(initialized.status, 0, 'Disposable database initialization must succeed.');
  const portProbe = createServer();
  const dbPort = await listen(portProbe);
  await new Promise(resolve => portProbe.close(resolve));
  process.env.DB_PORT = String(dbPort);
  const socket = join(directory, 'mysql.sock');
  const daemon = spawn('mariadbd', ['--no-defaults', '--datadir=' + directory, '--socket=' + socket, '--port=' + dbPort, '--bind-address=127.0.0.1', '--skip-name-resolve', '--pid-file=' + join(directory, 'mysql.pid'), '--log-error=' + join(directory, 'mysql.log')], { stdio: 'ignore' });
  t.after(async () => { await closeDatabase(); daemon.kill('SIGTERM'); await new Promise(resolve => daemon.once('exit', resolve)); await rm(directory, { recursive: true, force: true }); });
  let admin;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { admin = await mysql.createConnection({ socketPath: socket, user: 'root' }); break; } catch { await sleep(100); }
  }
  assert.ok(admin, 'Disposable MariaDB must start.');
  await admin.query('CREATE DATABASE keymeter_test CHARACTER SET utf8mb4 COLLATE utf8mb4_bin');
  await admin.query("CREATE USER 'keymeter_test'@'127.0.0.1' IDENTIFIED BY 'synthetic-test-db-password'");
  await admin.query("GRANT ALL PRIVILEGES ON keymeter_test.* TO 'keymeter_test'@'127.0.0.1'");
  await admin.end();
  process.env.DB_USER = 'keymeter_test';
  await migrateDatabase(new URL('../', import.meta.url));
  await migrateDatabase(new URL('../', import.meta.url));
  const statements = [];
  for (let i = 0; i < 35; i++) statements.push(database.prepare('INSERT INTO quota_checks (key_hash, checked_at, used_micros, remaining_micros) VALUES (?, ?, ?, ?)').bind('a'.repeat(64), new Date(1760000000000 + i).toISOString(), i, 35 - i));
  await database.batch(statements);
  const [, selected] = await database.batch([
    database.prepare(`DELETE FROM quota_checks WHERE id IN (
      SELECT id FROM quota_checks WHERE key_hash = ?
      ORDER BY checked_at DESC, id DESC LIMIT -1 OFFSET ?
    )`).bind('a'.repeat(64), 31),
    database.prepare('SELECT used_micros FROM quota_checks ORDER BY id'),
  ]);
  assert.equal(selected.results.length, 31);
  assert.equal(Number(selected.results[0].used_micros), 4);
  await database.prepare('INSERT INTO billing_connection (id, encrypted_session, updated_at, refresh_lock_until) VALUES (1, ?, ?, 0) ON CONFLICT(id) DO UPDATE SET encrypted_session = excluded.encrypted_session, updated_at = excluded.updated_at, refresh_lock_until = 0').bind('synthetic-ciphertext', 'now').run();
  const wrongCaseLock = await database.prepare('UPDATE billing_connection SET refresh_lock_until = ? WHERE id = 1 AND encrypted_session = ? AND refresh_lock_until <= ? RETURNING id').bind(30000, 'SYNTHETIC-CIPHERTEXT', 0).first();
  assert.equal(wrongCaseLock, null, 'Ciphertext comparison must remain case sensitive.');
  const takeLock = () => database.prepare('UPDATE billing_connection SET refresh_lock_until = ? WHERE id = 1 AND encrypted_session = ? AND refresh_lock_until <= ? RETURNING id').bind(30000, 'synthetic-ciphertext', 0).first();
  const acquired = await Promise.all([takeLock(), takeLock()]);
  assert.equal(acquired.filter(Boolean).length, 1);
  assert.deepEqual(acquired.find(Boolean), { id: 1 });
  const rate = () => database.batch([
    database.prepare('DELETE FROM request_limits WHERE reset_at < ?').bind(0),
    database.prepare('INSERT INTO request_limits (bucket_hash, reset_at, request_count) VALUES (?, ?, 1) ON CONFLICT(bucket_hash) DO UPDATE SET request_count = request_count + 1').bind('b'.repeat(64), 10000),
    database.prepare('SELECT request_count FROM request_limits WHERE bucket_hash = ?').bind('b'.repeat(64)),
  ]);
  const counts = await Promise.all(Array.from({ length: 5 }, rate));
  assert.deepEqual(counts.map(result => result[2].results[0].request_count).sort(), [1, 2, 3, 4, 5]);
  const login = (suppliedPassword, options = {}) => submitForm(origin, '/login', { email: 'owner@example.test', password: suppliedPassword }, '', options);
  delete process.env.ADMIN_EMAIL;
  assert.deepEqual(configProblems(), [], 'Owner email can be chosen at first verified sign-in.');
  const legacyHash = process.env.ADMIN_PASSWORD_HASH;
  delete process.env.ADMIN_PASSWORD_HASH;
  const missingSetup = await fetch(origin + '/login');
  assert.equal(missingSetup.status, 200);
  assert.match(await missingSetup.text(), /Add ADMIN_EMAIL/);
  process.env.ADMIN_PASSWORD_HASH = legacyHash;
  const wrongBootstrap = await login('wrong-bootstrap-password');
  assert.equal(wrongBootstrap.status, 401);
  assert.equal(delivered.length, 0, 'No email may be sent before the configured password is correct.');
  assert.equal(await ownerAccount(), null);
  for (const missingOrigin of [null, 'null']) {
    const compatible = await login('wrong-bootstrap-password', { origin: missingOrigin, headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(compatible.status, 401, 'A signed embedded-browser submission must reach password validation.');
    assert.match(await compatible.text(), /Email or owner key is incorrect/);
  }
  const unsigned = await fetch(origin + '/login', { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'owner@example.test', password }), redirect: 'manual' });
  assert.equal(unsigned.status, 403, 'Matching Origin alone must not bypass the form proof.');
  assert.match(unsigned.headers.get('content-type'), /text\/html/);
  assert.match(await unsigned.text(), /Please try signing in again/);
  const initialForm = await browserForm(origin, '/login');
  const submitBadProof = (csrf, cookie = initialForm.cookie) => fetch(origin + '/login', { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'owner@example.test', password, csrf }), redirect: 'manual' });
  assert.equal((await submitBadProof('invalid')).status, 403);
  assert.equal((await submitBadProof(initialForm.csrf, '')).status, 403);
  assert.equal((await submitBadProof(initialForm.csrf, initialForm.cookie + '; ' + initialForm.cookie)).status, 403);
  const stale = createFormProtection({ cookie: initialForm.cookie }, Date.now() - FORM_TTL * 1000 - 1000);
  assert.equal((await submitBadProof(stale.token)).status, 403);
  assert.equal((await login(password, { origin: 'https://evil.test' })).status, 403, 'Foreign Origin must be rejected even with a valid cookie and proof.');
  assert.equal(delivered.length, 0, 'Rejected form proofs must not reach email delivery.');
  const accepted = await login(password, { origin: 'null' });
  assert.equal(accepted.status, 303);
  assert.equal(accepted.headers.get('location'), origin + '/login/verify');
  const pendingCookie = accepted.headers.get('set-cookie').split(';')[0];
  assert.match(pendingCookie, /^keymeter-preauth=/);
  assert.equal((await fetch(origin + '/api/seller/billing', { headers: { cookie: pendingCookie } })).status, 403, 'Password stage must not authorize billing.');
  assert.deepEqual(delivered.at(-1).to, ['owner@example.test']);
  const code = latestCode();
  await browserForm(origin, '/login/verify', pendingCookie);
  const verify = (cookie, code) => submitForm(origin, '/login/verify', { code }, cookie, { origin: null });
  assert.equal((await fetch(origin + '/login/verify', { method: 'POST', headers: { origin: 'https://evil.test', cookie: pendingCookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code }), redirect: 'manual' })).status, 403);
  const verified = await verify(pendingCookie, code);
  assert.equal(verified.status, 303);
  const cookie = verified.headers.getSetCookie().find(value => value.startsWith('keymeter-session=')).split(';')[0];
  assert.match(verified.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await verify(pendingCookie, code)).status, 401, 'A consumed code must not be replayed.');
  const ownerResponse = await fetch(origin + '/api/seller/billing', { headers: { cookie } });
  assert.equal(ownerResponse.status, 200);
  assert.equal((await ownerResponse.json())['oai-authenticated-user-email'], 'owner@example.test');
  const stored = await getPool().execute('SELECT token_hash FROM auth_sessions');
  assert.ok(!JSON.stringify(stored).includes(cookie.split('=')[1]));
  let busyLogin;
  for (let i = 0; i < 13; i++) {
    const attempt = await login('wrong');
    if (attempt.status === 429) { busyLogin = attempt; break; }
    assert.equal(attempt.status, 401);
  }
  assert.ok(busyLogin, 'Repeated login attempts must receive bounded backoff.');
  assert.ok(Number(busyLogin.headers.get('retry-after')) <= 10);
  // Login throttling never invalidates an already signed-in owner's session.
  assert.equal((await fetch(origin + '/api/seller/billing', { headers: { cookie } })).status, 200);
  await getPool().execute('DELETE FROM request_limits');
  const testTime = Math.floor(Date.now() / 10_000) * 10_000;
  for (let i = 0; i < 6; i++) assert.equal((await checkLogin('owner@example.test', 'wrong', '127.0.0.8', testTime)).limited, false);
  assert.equal((await checkLogin('owner@example.test', password, '127.0.0.8', testTime)).limited, true);
  // A separate socket peer has its own small bucket, and a burst expires after
  // ten seconds instead of imposing a persistent fifteen-minute owner lockout.
  assert.equal((await checkLogin('owner@example.test', password, '127.0.0.9', testTime)).ok, true);
  assert.equal((await checkLogin('owner@example.test', password, '127.0.0.8', testTime + 10_000)).ok, true);
  await getPool().execute('DELETE FROM request_limits');
  const burst = await Promise.all(Array.from({ length: 6 }, () => checkLogin('owner@example.test', password, '127.0.0.9', testTime)));
  assert.equal(burst.filter(result => result.ok).length, 2, 'At most two password hashes may run concurrently.');
  assert.equal(burst.filter(result => result.limited && result.retryAfter === 2).length, 4);
  await getPool().execute('DELETE FROM request_limits');
  for (let i = 0; i < 20; i++) assert.equal((await checkLogin('owner@example.test', 'wrong', `127.0.0.${i + 10}`, testTime)).limited, false);
  assert.equal((await checkLogin('owner@example.test', password, '127.0.0.99', testTime)).limited, true);
  assert.equal((await checkLogin('owner@example.test', password, '127.0.0.99', testTime + 10_000)).ok, true);

  // OTP state is server-only, bounded, single-use, purpose-bound, and rotated on resend.
  await getPool().execute('DELETE FROM request_limits');
  const current = await ownerAccount();
  const proof = { owner_email: current.email, owner_version: current.version, purpose: 'login' };
  const capture = async (_url, init) => { delivered.push(JSON.parse(init.body)); return Response.json({ id: 'synthetic-code-test' }); };
  const base = Date.now();
  const challenge = await beginEmailChallenge(proof, '', true, capture, base);
  const rememberedCode = latestCode();
  const [challengeRows] = await getPool().execute('SELECT * FROM owner_email_challenges');
  assert.ok(!JSON.stringify(challengeRows).includes(challenge));
  assert.ok(challengeRows.every(row => /^[a-f0-9]{64}$/.test(row.code_hash) && row.code_hash !== rememberedCode));
  assert.equal(await emailChallenge(challenge, 'change', base), null, 'Login proof cannot become an email-change proof.');
  await assert.rejects(verifyEmailChallenge(challenge, rememberedCode, base + CODE_TTL * 1000), error => error.status === 401);
  const remembered = await verifyEmailChallenge(challenge, rememberedCode, base);
  assert.equal(remembered.ttl, REMEMBER_TTL);
  assert.ok(await authenticatedOwner(remembered.token));
  await assert.rejects(verifyEmailChallenge(challenge, rememberedCode, base), error => error.status === 401);
  await getPool().execute('DELETE FROM request_limits');
  const wrongChallenge = await beginEmailChallenge(proof, '', false, capture, base);
  const correctCode = latestCode();
  for (let i = 0; i < 5; i++) await assert.rejects(verifyEmailChallenge(wrongChallenge, correctCode === '000000' ? '111111' : '000000', base), error => error.status === 401);
  await assert.rejects(verifyEmailChallenge(wrongChallenge, correctCode, base), error => error.status === 401);
  await getPool().execute('DELETE FROM request_limits');
  const oldChallenge = await beginEmailChallenge(proof, '', false, capture, base);
  const oldCode = latestCode();
  await assert.rejects(resendEmailChallenge(oldChallenge, 'login', capture, base + 1000), error => error.status === 429);
  const replaced = await resendEmailChallenge(oldChallenge, 'login', capture, base + 61_000);
  await assert.rejects(verifyEmailChallenge(oldChallenge, oldCode, base + 61_000), error => error.status === 401);
  const rotatedCode = latestCode();
  const race = await Promise.allSettled([verifyEmailChallenge(replaced, rotatedCode, base + 61_000), verifyEmailChallenge(replaced, rotatedCode, base + 61_000)]);
  assert.equal(race.filter(result => result.status === 'fulfilled').length, 1);
  await getPool().execute('DELETE FROM request_limits');
  const failure = await beginEmailChallenge(proof, '', false, async () => new Response(null, { status: 503 }), base).then(() => null, error => error);
  assert.equal(failure.status, 503);
  assert.ok(await authenticatedOwner(remembered.token), 'Mail outages must preserve existing authenticated sessions.');
  const savedKey = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  assert.ok(await authenticatedOwner(remembered.token), 'Missing email configuration must not revoke an authenticated browser.');
  assert.equal((await fetch(origin)).status, 200, 'Public checker forwarding remains available without mail configuration.');
  assert.deepEqual(configProblems(), [], 'Missing email setup must not take the public checker offline.');
  await assert.rejects(beginEmailChallenge(proof, '', false, capture, base), error => error.status === 503);
  process.env.RESEND_API_KEY = savedKey;
  for (const response of [new Response(null, { status: 302, headers: { location: 'https://evil.test/' } }), Response.json({ error: 'synthetic' }), new Response('x'.repeat(20_000))]) {
    await assert.rejects(sendLoginCode('123456', current.email, async () => response), error => error.status === 503);
  }
  const settingsWithoutLogin = await fetch(origin + '/owner/email', { redirect: 'manual' });
  assert.equal(settingsWithoutLogin.status, 303);
  const settingsWithLogin = await fetch(origin + '/owner/email', { headers: { cookie: cookieHeader(remembered.token).split(';')[0] } });
  assert.equal(settingsWithLogin.status, 200);
  assert.match(await settingsWithLogin.text(), /Current owner key/);
  for (const path of ['/login/verify', '/login/resend', '/logout', '/owner/email/start', '/owner/email/verify', '/owner/email/resend', '/forgot-key', '/forgot-key/verify', '/forgot-key/resend']) {
    const unsignedAction = await fetch(origin + path, { method: 'POST', headers: { origin, cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: 'code=000000', redirect: 'manual' });
    assert.equal(unsignedAction.status, 403, `${path} must require a form proof.`);
  }
  const settingsCookie = cookieHeader(remembered.token).split(';')[0];
  const rejectedChange = await submitForm(origin, '/owner/email/start', { email: 'new-owner@example.test', password: 'wrong-password' }, settingsCookie, { page: '/owner/email', origin: null });
  assert.equal(rejectedChange.status, 401, 'A valid form proof does not replace password reauthentication.');
  const foreignLogout = await submitForm(origin, '/logout', {}, settingsCookie, { page: '/owner/email', origin: 'https://evil.test' });
  assert.equal(foreignLogout.status, 403);
  assert.ok(await authenticatedOwner(remembered.token), 'A rejected logout must preserve the signed-in session.');
  const logout = await submitForm(origin, '/logout', {}, cookie, { page: '/owner/email', origin: 'null' });
  assert.equal(logout.status, 303, 'Sign out supports the same signed embedded-browser forms.');
  assert.equal((await fetch(origin + '/api/seller/billing', { headers: { cookie } })).status, 403);
  // Email changes require current password (gateway), an old-email code, then a new-email code.
  await getPool().execute('DELETE FROM request_limits');
  const change = await beginEmailChallenge({ ...proof, purpose: 'change-old', new_email: 'new-owner@example.test' }, '', false, capture, base);
  await assert.rejects(verifyEmailChallenge(change, latestCode(), base), error => error.status === 401);
  const oldVerified = await verifyEmailChange(change, latestCode(), capture, base);
  assert.ok(oldVerified.challenge);
  assert.deepEqual(delivered.at(-1).to, ['new-owner@example.test']);
  assert.equal((await ownerAccount()).email, current.email);
  const newVerified = await verifyEmailChange(oldVerified.challenge, latestCode(), capture, base);
  assert.equal((await ownerAccount()).email, 'new-owner@example.test');
  assert.equal(await authenticatedOwner(remembered.token), null);
  assert.ok(await authenticatedOwner(newVerified.token));
  await assert.rejects(verifyEmailChange(oldVerified.challenge, latestCode(), capture, base), error => error.status === 401);
  // Restore the fixture owner for the compiled app smoke test, with a fresh verified session.
  await getPool().execute('DELETE FROM request_limits');
  const changed = await ownerAccount();
  const restore = await beginEmailChallenge({ owner_email: changed.email, owner_version: changed.version, purpose: 'change-old', new_email: current.email }, '', false, capture, base);
  const restoreNew = await verifyEmailChange(restore, latestCode(), capture, base);
  const restored = await verifyEmailChange(restoreNew.challenge, latestCode(), capture, base);
  let restoredCookie = cookieHeader(restored.token).split(';')[0];
  // The first verified email claim has exactly one atomic winner, even when two
  // browser challenges were created before either could establish the account.
  await getPool().execute('DELETE FROM auth_sessions');
  await getPool().execute('DELETE FROM owner_account');
  await getPool().execute('DELETE FROM owner_email_challenges');
  await getPool().execute('DELETE FROM request_limits');
  const bootstrapLogin = await checkLogin('owner@example.test', password, '127.0.0.35', base);
  assert.equal(bootstrapLogin.ok, true);
  assert.equal(bootstrapLogin.ownerVersion, 'bootstrap');
  const firstProof = { owner_email: bootstrapLogin.email, owner_version: 'bootstrap', purpose: 'login' };
  const firstClaim = await beginEmailChallenge(firstProof, '', false, capture, base);
  const firstCode = latestCode();
  const secondClaim = await beginEmailChallenge(firstProof, '', false, capture, base);
  const secondCode = latestCode();
  const claims = await Promise.allSettled([verifyEmailChallenge(firstClaim, firstCode, base), verifyEmailChallenge(secondClaim, secondCode, base)]);
  assert.equal(claims.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await ownerAccount()).email, 'owner@example.test');
  const winner = claims.find(result => result.status === 'fulfilled').value;
  restoredCookie = cookieHeader(winner.token).split(';')[0];
  await assert.rejects(beginEmailChallenge({ ...firstProof, owner_email: 'different-owner@example.test' }, '', false, capture, base), error => error.status === 401);

  // First setup issues the key only in the verified POST response. Forgotten-key
  // recovery uses the same browser proof but a distinct server-side OTP purpose.
  await getPool().execute('DELETE FROM owner_account');
  await getPool().execute('DELETE FROM auth_sessions');
  await getPool().execute('DELETE FROM owner_email_challenges');
  await getPool().execute('DELETE FROM request_limits');
  process.env.ADMIN_EMAIL = 'owner@example.test';
  const setupForm = await browserForm(origin, '/login');
  assert.match(setupForm.html, /Send setup code/);
  assert.doesNotMatch(setupForm.html, /name="password"/);
  assert.doesNotMatch(setupForm.html, /requestSubmit/);
  const setupLink = await browserForm(origin, '/login?start=setup');
  assert.match(setupLink.html, /requestSubmit/);
  const beforeUnknown = delivered.length;
  const unknownSetup = await submitForm(origin, '/login', { email: 'stranger@example.test' });
  assert.equal(unknownSetup.status, 303);
  assert.equal(delivered.length, beforeUnknown);
  const setupStart = await submitForm(origin, '/login', { email: 'owner@example.test' }, '', { origin: 'null' });
  assert.equal(setupStart.status, 303);
  const setupPending = setupStart.headers.getSetCookie()[0].split(';')[0];
  const setupCode = latestCode();
  const alreadyStarted = await fetch(origin + '/login?start=setup', { headers: { cookie: setupPending }, redirect: 'manual' });
  assert.equal(alreadyStarted.status, 303);
  assert.equal(alreadyStarted.headers.get('location'), origin + '/login/verify');
  const issuedResponse = await submitForm(origin, '/login/verify', { code: setupCode }, setupPending, { page: '/login/verify', origin: null });
  assert.equal(issuedResponse.status, 200);
  assert.match(issuedResponse.headers.get('cache-control'), /no-store/);
  const issuedHtml = await issuedResponse.text();
  const firstKey = /id="owner-key"[^>]*>([^<]+)<\/textarea>/.exec(issuedHtml)?.[1];
  assert.equal(firstKey?.length, 64);
  assert.match(issuedHtml, /shown once/);
  assert.doesNotMatch((await browserForm(origin, '/login?start=setup')).html, /requestSubmit/);
  let keyCookie = issuedResponse.headers.getSetCookie().find(value => value.startsWith('keymeter-session=')).split(';')[0];
  assert.equal((await fetch(origin + '/api/seller/billing', { headers: { cookie: keyCookie } })).status, 200);
  const replaySetup = await submitForm(origin, '/login/verify', { code: setupCode }, setupPending);
  assert.equal(replaySetup.status, 401);
  assert.ok(!(await replaySetup.text()).includes(firstKey), 'A consumed setup proof cannot show the key again.');
  const knownLogin = await login(firstKey);
  assert.equal(knownLogin.status, 303);
  const keyLoginPending = knownLogin.headers.getSetCookie()[0].split(';')[0];
  const normalSignedIn = await verify(keyLoginPending, latestCode());
  assert.equal(normalSignedIn.status, 303, 'Later logins require key plus email code and do not reissue the key.');
  await getPool().execute('DELETE FROM request_limits');
  const recoveryUnknown = await submitForm(origin, '/forgot-key', { email: 'stranger@example.test' }, '', { page: '/forgot-key' });
  const recoveryKnown = await submitForm(origin, '/forgot-key', { email: 'owner@example.test' }, '', { page: '/forgot-key', origin: null });
  assert.equal(recoveryUnknown.status, recoveryKnown.status);
  assert.equal(recoveryKnown.status, 303);
  assert.equal(recoveryUnknown.headers.get('location'), recoveryKnown.headers.get('location'));
  const recoveryPending = recoveryKnown.headers.getSetCookie()[0].split(';')[0];
  const recovery = await submitForm(origin, '/forgot-key/verify', { code: latestCode() }, recoveryPending, { page: '/forgot-key/verify', origin: 'null' });
  assert.equal(recovery.status, 200);
  const recoveredHtml = await recovery.text();
  const recoveredKey = /id="owner-key"[^>]*>([^<]+)<\/textarea>/.exec(recoveredHtml)?.[1];
  assert.equal(recoveredKey?.length, 64);
  assert.notEqual(recoveredKey, firstKey);
  assert.equal((await fetch(origin + '/api/seller/billing', { headers: { cookie: keyCookie } })).status, 403);
  restoredCookie = recovery.headers.getSetCookie().find(value => value.startsWith('keymeter-session=')).split(';')[0];
  assert.equal((await login(firstKey)).status, 401);
  assert.equal((await login(password)).status, 401, 'The old environment password must not bypass a recovered DB key.');
  assert.equal((await login(recoveredKey)).status, 303);


  // Exercise the compiled application through its production Node entry point.
  const siteRoot = new URL('../../', import.meta.url);
  try { await access(new URL('dist/hostinger-build.json', siteRoot)); }
  catch { t.diagnostic('Production-entry smoke check requires npm run build:hostinger.'); return; }
  await getPool().execute('DELETE FROM request_limits');
  await getPool().execute('DELETE FROM billing_connection');
  const publicProbe = createServer();
  const publicPort = await listen(publicProbe);
  await new Promise(resolve => publicProbe.close(resolve));
  const productionOrigin = 'http://127.0.0.1:' + publicPort;
  const production = spawn(process.execPath, ['server.mjs'], { cwd: siteRoot, env: { ...process.env, PORT: String(publicPort), APP_URL: productionOrigin }, stdio: 'ignore' });
  t.after(async () => { production.kill('SIGTERM'); if (production.exitCode === null) await new Promise(resolve => production.once('exit', resolve)); });
  let homepage;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { homepage = await fetch(productionOrigin); break; } catch { await sleep(100); }
  }
  assert.ok(homepage, 'Production server must start.');
  assert.equal(homepage.status, 200);
  const homepageHtml = await homepage.text();
  assert.match(homepageHtml, /Keymeter/);
  const priceCard = /<aside\b[\s\S]*?<\/aside>/.exec(homepageHtml)?.[0];
  const contactDialog = /<dialog\b[\s\S]*?<\/dialog>/.exec(homepageHtml)?.[0];
  assert.ok(priceCard, 'Package pricing must be visible on the server-rendered page.');
  assert.match(priceCard, /62,000/);
  assert.match(priceCard, /588,800/);
  assert.match(priceCard, /Top up my key/);
  assert.ok(contactDialog);
  assert.doesNotMatch(contactDialog, /<table|62,000/);
  assert.match(contactDialog, /https:\/\/t\.me\/LynnIsHeree/);
  assert.match(contactDialog, /61579857132090/);
  for (const path of ['/.env', '/server.mjs', '/hostinger/config.mjs', '/.openai/hosting.json', '/server/index.js', '/assets/%2e%2e%2f%2e%2e%2fserver.mjs']) {
    const privateFile = await fetch(productionOrigin + path, { redirect: 'manual' });
    assert.ok([403, 404].includes(privateFile.status), 'Private source must not be served at ' + path);
  }
  assert.equal((await fetch(productionOrigin + '/api/seller/billing', { headers: spoof })).status, 403);
  const codePage = await fetch(productionOrigin + '/login', { redirect: 'manual' });
  assert.equal(codePage.status, 200);
  assert.match(await codePage.text(), /Send sign-in code/);
  const ownerCookie = restoredCookie;
  const setup = await fetch(productionOrigin + '/seller', { headers: { cookie: ownerCookie } });
  assert.equal(setup.status, 200);
  assert.match(await setup.text(), /Connect your billing/);
  const actualStatus = await fetch(productionOrigin + '/api/seller/billing', { headers: { cookie: ownerCookie } });
  assert.equal(actualStatus.status, 200);
  assert.equal((await actualStatus.json()).connected, false);
  const publicPrices = await fetch(productionOrigin + '/api/pricing');
  assert.equal(publicPrices.status, 200);
  const defaults = (await publicPrices.json()).packages;
  assert.deepEqual(defaults, [{ usd: 10, kyat: 62000 }, { usd: 20, kyat: 124000 }, { usd: 30, kyat: 186000 }, { usd: 40, kyat: 248000 }, { usd: 50, kyat: 299900 }, { usd: 100, kyat: 588800 }]);
  for (const method of ['GET', 'PUT']) {
    assert.equal((await fetch(productionOrigin + '/api/seller/pricing', { method, headers: { ...spoof, origin: productionOrigin, 'content-type': 'application/json' }, ...(method === 'PUT' ? { body: JSON.stringify({ packages: defaults }) } : {}) })).status, 403);
  }
  const pricesForOwner = await fetch(productionOrigin + '/api/seller/pricing', { headers: { cookie: ownerCookie } });
  assert.equal(pricesForOwner.status, 200);
  const updated = defaults.map(row => ({ ...row, kyat: row.usd === 10 ? 63000 : row.kyat }));
  const savePrices = packages => fetch(productionOrigin + '/api/seller/pricing', { method: 'PUT', headers: { cookie: ownerCookie, origin: productionOrigin, 'content-type': 'application/json' }, body: JSON.stringify({ packages }) });
  assert.equal((await savePrices(updated)).status, 200);
  assert.deepEqual((await (await fetch(productionOrigin + '/api/pricing')).json()).packages, updated);
  const updatedHome = await (await fetch(productionOrigin)).text();
  assert.match(/<aside\b[\s\S]*?<\/aside>/.exec(updatedHome)?.[0] || '', /63,000/,
    'Owner price changes must appear in the visible page card without opening a dialog.');
  assert.equal((await savePrices(defaults)).status, 200);

});

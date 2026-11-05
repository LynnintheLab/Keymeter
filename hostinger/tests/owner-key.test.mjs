import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';
import { closeDatabase, getPool, migrateDatabase } from '../database.mjs';
import { authenticatedOwner, checkLogin, ownerAccount, passwordHash, verifyPassword } from '../security.mjs';
import { beginEmailChallenge, beginKeyRecovery, beginOwnerSetup, CODE_TTL, verifyOwnerKeyChallenge } from '../email-auth.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, sleep(5000)]);
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
}
function keyShape(key) {
  assert.equal(typeof key, 'string');
  assert.equal(key.length, 64);
  assert.ok(/^[\x21-\x7e]+$/.test(key), 'Owner keys must be printable ASCII.');
  for (const pattern of [/[A-Z]/, /[a-z]/, /[0-9]/, /[^A-Za-z0-9]/])
    assert.ok(pattern.test(key), 'Owner keys must include every required character class.');
}

test('owner key setup, recovery, migration and mail budgets fail closed without losing billing', async t => {
  if (spawnSync('mariadb-install-db', ['--help'], { stdio: 'ignore' }).error) {
    t.skip('Disposable MariaDB is unavailable.'); return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'keymeter-owner-key-test-'));
  const socket = join(directory, 'db.sock');
  const rootPassword = randomBytes(32).toString('base64url');
  const databasePassword = randomBytes(32).toString('base64url');
  const legacyKey = 'synthetic-legacy-owner-key-for-migration';
  const pinnedEmail = 'owner@example.test';
  Object.assign(process.env, {
    APP_URL: 'http://127.0.0.1:3000', ADMIN_EMAIL: pinnedEmail,
    ADMIN_PASSWORD_HASH: await passwordHash(legacyKey), SESSION_SECRET: randomBytes(32).toString('base64url'),
    BILLING_ENCRYPTION_KEY: randomBytes(32).toString('base64'), RESEND_API_KEY: 're_synthetic_owner_key_fixture',
    AUTH_EMAIL_FROM: 'Keymeter <keys@example.test>', DB_HOST: '127.0.0.1', DB_NAME: 'keymeter_owner_key_test',
    DB_USER: 'keymeter_fixture', DB_PASSWORD: databasePassword,
  });
  let daemon;
  t.after(async () => { await closeDatabase(); await stop(daemon); await rm(directory, { recursive: true, force: true }); });
  const initialized = spawnSync('mariadb-install-db', ['--no-defaults', '--datadir=' + directory,
    '--auth-root-authentication-method=normal', '--skip-test-db'], { stdio: 'ignore' });
  assert.equal(initialized.status, 0, 'The disposable database must initialize.');
  function start(network = false, port) {
    const child = spawn('mariadbd', ['--no-defaults', '--datadir=' + directory, '--socket=' + socket,
      '--pid-file=' + join(directory, 'db.pid'), '--log-error=' + join(directory, 'db.log'), '--skip-name-resolve',
      ...(network ? ['--bind-address=127.0.0.1', '--port=' + port] : ['--skip-networking'])], { stdio: 'ignore' });
    child.on('error', () => {}); return child;
  }
  async function adminConnection(password = '') {
    for (let i = 0; i < 100; i++) {
      if (daemon.exitCode !== null || daemon.signalCode !== null) break;
      try { return await mysql.createConnection({ socketPath: socket, user: 'root', password }); }
      catch { await sleep(100); }
    }
    assert.fail('The disposable database must become ready.');
  }
  // Configure every login before starting even a loopback TCP listener.
  daemon = start();
  const admin = await adminConnection();
  const [accounts] = await admin.query('SELECT User, Host FROM mysql.user');
  for (const account of accounts) {
    if ((account.User === 'root' && account.Host === 'localhost') || account.User === 'mariadb.sys') continue;
    await admin.query('DROP USER IF EXISTS ?@?', [account.User, account.Host]);
  }
  await admin.query("ALTER USER 'root'@'localhost' IDENTIFIED BY ?", [rootPassword]);
  await admin.query('CREATE DATABASE keymeter_owner_key_test CHARACTER SET utf8mb4 COLLATE utf8mb4_bin');
  await admin.query("CREATE USER 'keymeter_fixture'@'127.0.0.1' IDENTIFIED BY ?", [databasePassword]);
  await admin.query("GRANT ALL PRIVILEGES ON keymeter_owner_key_test.* TO 'keymeter_fixture'@'127.0.0.1'");
  await admin.end();
  await stop(daemon);
  const port = await freePort();
  process.env.DB_PORT = String(port);
  daemon = start(true, port);
  await (await adminConnection(rootPassword)).end();
  await migrateDatabase(new URL('../', import.meta.url));
  await migrateDatabase(new URL('../', import.meta.url));
  const pool = getPool();
  const mail = [];
  const transport = async (url, init) => {
    assert.equal(url, 'https://api.resend.com/emails');
    assert.equal(init.redirect, 'error');
    const payload = JSON.parse(init.body);
    const code = /\b(\d{6})\b/.exec(payload.text)?.[1];
    assert.ok(code, 'Synthetic delivery must contain one verification code.');
    mail.push({ code, to: payload.to });
    return Response.json({ id: 'synthetic-message-id' });
  };
  const latest = () => mail.at(-1).code;
  const resetRate = () => pool.execute('DELETE FROM request_limits');
  const now = Date.now();
  let initialKey, initialSession;

  await t.test('bootstrap is pinned, delivery-gated, atomic and stores no plaintext key', async () => {
    assert.equal(await beginOwnerSetup('foreign@example.test', '', transport, now), null);
    assert.equal(mail.length, 0);
    const configuredEmail = process.env.ADMIN_EMAIL;
    delete process.env.ADMIN_EMAIL;
    assert.equal(await beginOwnerSetup(pinnedEmail, '', transport, now), null);
    process.env.ADMIN_EMAIL = configuredEmail;
    const mailKey = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    await assert.rejects(beginOwnerSetup(pinnedEmail, '', transport, now), error => error.status === 503);
    assert.equal(await ownerAccount(), null);
    process.env.RESEND_API_KEY = mailKey;
    await assert.rejects(beginOwnerSetup(pinnedEmail, '', async () => new Response(null, { status: 503 }), now), error => error.status === 503);
    assert.equal(await ownerAccount(), null);
    await resetRate();
    const one = await beginOwnerSetup(pinnedEmail, '', transport, now), oneCode = latest();
    const two = await beginOwnerSetup(pinnedEmail, '', transport, now), twoCode = latest();
    assert.deepEqual(mail.at(-1).to, [pinnedEmail]);
    const outcomes = await Promise.allSettled([
      verifyOwnerKeyChallenge(one, oneCode, 'setup', now), verifyOwnerKeyChallenge(two, twoCode, 'setup', now),
    ]);
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1, 'Only one first owner claim may win.');
    const winner = outcomes.find(result => result.status === 'fulfilled').value;
    initialKey = winner.key; initialSession = winner.token;
    keyShape(initialKey);
    const row = await ownerAccount();
    assert.equal(row.email, pinnedEmail);
    assert.ok(row.password_hash && row.password_hash !== initialKey);
    assert.equal(await verifyPassword(initialKey, row.password_hash), true);
    assert.ok(!JSON.stringify(await pool.execute('SELECT * FROM owner_account')).includes(initialKey));
    assert.equal((await authenticatedOwner(initialSession)).email, pinnedEmail);
    await assert.rejects(verifyOwnerKeyChallenge(one, oneCode, 'setup', now), error => error.status === 401);
    assert.equal(await beginOwnerSetup(pinnedEmail, '', transport, now), null);
    await resetRate();
    assert.equal((await checkLogin(pinnedEmail, initialKey, '127.0.0.2', now)).ok, true);
    assert.equal((await checkLogin(pinnedEmail, legacyKey, '127.0.0.2', now)).ok, false, 'The environment key must not remain a second valid credential.');
  });

  await t.test('recovery proves purpose and expiry, rotates once and preserves saved billing', async () => {
    await pool.execute('INSERT INTO billing_connection (id, encrypted_session, updated_at, refresh_lock_until) VALUES (1, ?, ?, 0)', ['synthetic-preserved-billing-ciphertext', 'synthetic-time']);
    const before = await ownerAccount();
    assert.equal(await beginKeyRecovery('foreign@example.test', '', transport, now), null);
    await resetRate();
    const expired = await beginKeyRecovery(pinnedEmail, '', transport, now), expiredCode = latest();
    await assert.rejects(verifyOwnerKeyChallenge(expired, expiredCode, 'recover', now + CODE_TTL * 1000), error => error.status === 401);
    await resetRate();
    const recovery = await beginKeyRecovery(pinnedEmail, '', transport, now), code = latest();
    await assert.rejects(verifyOwnerKeyChallenge(recovery, code, 'setup', now), error => error.status === 401);
    await assert.rejects(verifyOwnerKeyChallenge(recovery, code === '000000' ? '111111' : '000000', 'recover', now), error => error.status === 401);
    const outcomes = await Promise.allSettled([
      verifyOwnerKeyChallenge(recovery, code, 'recover', now), verifyOwnerKeyChallenge(recovery, code, 'recover', now),
    ]);
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1, 'Recovery must issue only one replacement.');
    const winner = outcomes.find(result => result.status === 'fulfilled').value;
    keyShape(winner.key);
    assert.ok(winner.key !== initialKey);
    const after = await ownerAccount();
    assert.ok(after.version !== before.version && after.password_hash !== before.password_hash);
    assert.equal(await authenticatedOwner(initialSession), null);
    assert.equal((await authenticatedOwner(winner.token)).email, pinnedEmail);
    await assert.rejects(verifyOwnerKeyChallenge(recovery, code, 'recover', now), error => error.status === 401);
    await resetRate();
    assert.equal((await checkLogin(pinnedEmail, initialKey, '127.0.0.2', now)).ok, false);
    assert.equal((await checkLogin(pinnedEmail, legacyKey, '127.0.0.2', now)).ok, false);
    assert.equal((await checkLogin(pinnedEmail, winner.key, '127.0.0.2', now)).ok, true);
    const [[billing]] = await pool.execute('SELECT encrypted_session FROM billing_connection WHERE id = 1');
    assert.equal(billing.encrypted_session, 'synthetic-preserved-billing-ciphertext');
    const [[pending]] = await pool.execute('SELECT COUNT(*) AS total FROM owner_email_challenges');
    assert.equal(Number(pending.total), 0);
    assert.ok(!JSON.stringify(await pool.execute('SELECT * FROM owner_account')).includes(winner.key));
  });

  await t.test('public recovery requests cannot consume the known-key login mail budget', async () => {
    await resetRate();
    for (let i = 0; i < 3; i++) await beginKeyRecovery(pinnedEmail, '', transport, now);
    await assert.rejects(beginKeyRecovery(pinnedEmail, '', transport, now), error => error.status === 429);
    const row = await ownerAccount();
    const login = await beginEmailChallenge({ owner_email: row.email, owner_version: row.version, purpose: 'login' }, '', false, transport, now);
    assert.equal(typeof login, 'string');
  });

  await t.test('a migrated owner uses the environment hash only until verified recovery sets a database key', async () => {
    await pool.execute('DELETE FROM auth_sessions');
    await pool.execute('DELETE FROM owner_email_challenges');
    await pool.execute('DELETE FROM owner_account');
    await pool.execute('INSERT INTO owner_account (id, email, version, password_hash) VALUES (1, ?, ?, NULL)', [pinnedEmail, randomBytes(16).toString('hex')]);
    await resetRate();
    assert.equal((await checkLogin(pinnedEmail, legacyKey, '127.0.0.2', now)).ok, true);
    const token = await beginKeyRecovery(pinnedEmail, '', transport, now), code = latest();
    const replacement = await verifyOwnerKeyChallenge(token, code, 'recover', now);
    keyShape(replacement.key);
    await resetRate();
    assert.equal((await checkLogin(pinnedEmail, legacyKey, '127.0.0.2', now)).ok, false);
    assert.equal((await checkLogin(pinnedEmail, replacement.key, '127.0.0.2', now)).ok, true);
  });
});

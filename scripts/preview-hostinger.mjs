import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

// A separate, loopback-only preview. This never imports production credentials
// or substitutes test email delivery for the real owner authentication flow.
process.umask(0o077);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const state = join(root, '.sites-runtime', 'hostinger-preview');
const configFile = join(state, 'config.json');
const accessFile = join(state, 'owner-access.txt');
const data = join(state, 'database');
const socket = join(state, 'db.sock');
const pidFile = join(state, 'db.pid');
const launchLock = join(state, 'launcher.lock');
let databaseProcess, appProcess, locked = false, closing = false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function exists(path) { try { await stat(path); return true; } catch { return false; } }
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, sleep(5000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}
async function cleanup(code = 0) {
  if (closing) return;
  closing = true;
  await stop(appProcess);
  await stop(databaseProcess);
  if (locked) await rm(launchLock, { force: true });
  process.exitCode = code;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  void cleanup().then(() => process.exit());
});

async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}
async function reserveAppPort(port) {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', resolve);
  });
  await new Promise(resolve => probe.close(resolve));
}
async function daemon(config, network = false, port = 0) {
  const log = await open(join(state, 'database-console.log'), 'a', 0o600);
  const child = spawn('mariadbd', ['--no-defaults', '--datadir=' + data,
    '--socket=' + socket, '--pid-file=' + pidFile, '--log-error=' + join(state, 'database.log'),
    '--skip-name-resolve', ...(network ? ['--bind-address=127.0.0.1', '--port=' + port] : ['--skip-networking'])],
  { stdio: ['ignore', log.fd, log.fd] });
  await log.close();
  child.on('error', () => {});
  databaseProcess = child;
  return child;
}
async function connectSocket(config, newDatabase) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (databaseProcess.exitCode !== null || databaseProcess.signalCode !== null)
      throw new Error('The local database did not start.');
    try {
      return await mysql.createConnection({ socketPath: socket, user: 'root',
        password: newDatabase ? '' : config.PREVIEW_DB_ROOT_PASSWORD, connectTimeout: 1000 });
    } catch { await sleep(100); }
  }
  throw new Error('The local database did not become ready.');
}
async function configureDatabase(config, fresh) {
  await daemon(config);
  const admin = await connectSocket(config, fresh);
  try {
    // Remove every installer-created login except the root socket account and
    // MariaDB's locked internal account before any TCP listener is started.
    const [accounts] = await admin.query('SELECT User, Host FROM mysql.user');
    for (const account of accounts) {
      if ((account.User === 'root' && account.Host === 'localhost') || account.User === 'mariadb.sys') continue;
      await admin.query('DROP USER IF EXISTS ?@?', [account.User, account.Host]);
    }
    await admin.query("ALTER USER 'root'@'localhost' IDENTIFIED BY ?", [config.PREVIEW_DB_ROOT_PASSWORD]);
    await admin.query('CREATE DATABASE IF NOT EXISTS keymeter_preview CHARACTER SET utf8mb4 COLLATE utf8mb4_bin');
    await admin.query("CREATE USER 'keymeter_preview'@'127.0.0.1' IDENTIFIED BY ?", [config.DB_PASSWORD]);
    await admin.query("GRANT ALL PRIVILEGES ON keymeter_preview.* TO 'keymeter_preview'@'127.0.0.1'");
  } finally { await admin.end(); }
  await stop(databaseProcess);
  const port = await freePort();
  await daemon(config, true, port);
  const ready = await connectSocket(config, false);
  await ready.end();
  return port;
}
async function loadConfiguration() {
  await mkdir(state, { recursive: true, mode: 0o700 });
  await chmod(state, 0o700);
  if (!await exists(configFile)) {
    const config = {
      APP_URL: 'http://127.0.0.1:5175', PORT: '5175', ADMIN_EMAIL: '',
      ADMIN_PASSWORD_HASH: '',
      SESSION_SECRET: randomBytes(32).toString('base64url'),
      BILLING_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      DB_PASSWORD: randomBytes(32).toString('base64url'),
      PREVIEW_DB_ROOT_PASSWORD: randomBytes(32).toString('base64url'),
      RESEND_API_KEY: '', AUTH_EMAIL_FROM: '',
    };
    await writeFile(configFile, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await writeFile(accessFile,
      'LOCAL PREVIEW ONLY — private setup notes\n\nSet ADMIN_EMAIL to your fixed owner email, and configure RESEND_API_KEY and AUTH_EMAIL_FROM privately in config.json. Restart this preview, then verify the emailed setup code at /login. A 64-character owner key will be shown once in the browser; save it privately. No owner key or email code is written to this file.\n\nLater sign-ins require the owner key and an email code. Forgot key verifies your current owner email and replaces the key while preserving the saved RunningHub connection.\n\nKeep the database, session, and encryption secrets unchanged to preserve this local preview. Existing local settings and data are never reset by this launcher. Production hosting uses separate settings.\n',
      { mode: 0o600, flag: 'wx' });
  }
  await chmod(configFile, 0o600);
  if (await exists(accessFile)) await chmod(accessFile, 0o600);
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  const port = Number(config.PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 ||
      config.APP_URL !== `http://127.0.0.1:${port}` ||
      !/^[A-Za-z0-9_-]{43}$/.test(config.PREVIEW_DB_ROOT_PASSWORD || '') ||
      !/^[A-Za-z0-9_-]{43}$/.test(config.DB_PASSWORD || ''))
    throw new Error('Private local preview settings are invalid.');
  return config;
}
async function main() {
  const marker = JSON.parse(await readFile(join(root, 'dist', 'hostinger-build.json'), 'utf8').catch(() => '{}'));
  if (marker.target !== 'hostinger') throw new Error('Run npm run build:hostinger before starting this preview.');
  for (const binary of ['mariadb-install-db', 'mariadbd']) {
    if (spawnSync(binary, ['--help'], { stdio: 'ignore' }).error) throw new Error('Install MariaDB before running the local preview.');
  }
  const config = await loadConfiguration();
  await reserveAppPort(Number(config.PORT));
  try {
    const lock = await open(launchLock, 'wx', 0o600);
    await lock.writeFile(String(process.pid)); await lock.close(); locked = true;
  } catch {
    let previous = 0;
    try { previous = Number(await readFile(launchLock, 'utf8')); } catch {}
    let running = false;
    if (Number.isSafeInteger(previous) && previous > 0) { try { process.kill(previous, 0); running = true; } catch {} }
    if (running) throw new Error('A local preview launcher is already running.');
    await rm(launchLock, { force: true });
    const lock = await open(launchLock, 'wx', 0o600);
    await lock.writeFile(String(process.pid)); await lock.close(); locked = true;
  }
  if (await exists(pidFile)) {
    const previous = Number((await readFile(pidFile, 'utf8')).trim());
    if (Number.isSafeInteger(previous) && previous > 0) {
      try { process.kill(previous, 0); throw new Error('The preview database is already running. Stop its previous launcher first.'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
  const fresh = !await exists(join(data, 'mysql'));
  if (fresh) {
    await mkdir(data, { recursive: true, mode: 0o700 });
    const log = await open(join(state, 'database-install.log'), 'a', 0o600);
    const result = spawnSync('mariadb-install-db', ['--no-defaults', '--datadir=' + data,
      '--auth-root-authentication-method=normal', '--skip-test-db'], { stdio: ['ignore', log.fd, log.fd] });
    await log.close();
    if (result.status !== 0) throw new Error('The private local database could not be initialized.');
  }
  const dbPort = await configureDatabase(config, fresh);
  const childEnv = {};
  for (const name of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'])
    if (process.env[name]) childEnv[name] = process.env[name];
  for (const name of ['APP_URL', 'PORT', 'ADMIN_EMAIL', 'ADMIN_PASSWORD_HASH', 'SESSION_SECRET', 'BILLING_ENCRYPTION_KEY', 'RESEND_API_KEY', 'AUTH_EMAIL_FROM'])
    if (typeof config[name] === 'string') childEnv[name] = config[name];
  Object.assign(childEnv, { DB_HOST: '127.0.0.1', DB_PORT: String(dbPort), DB_NAME: 'keymeter_preview',
    DB_USER: 'keymeter_preview', DB_PASSWORD: config.DB_PASSWORD, KEYMETER_BIND_HOST: '127.0.0.1' });
  const log = await open(join(state, 'app.log'), 'a', 0o600);
  appProcess = spawn(process.execPath, ['server.mjs'], { cwd: root, env: childEnv, stdio: ['ignore', log.fd, log.fd] });
  await log.close();
  appProcess.on('error', () => {});
  // Only the final TCP daemon is watched. The earlier offline bootstrap daemon
  // is deliberately stopped before the app is launched.
  const activeDatabase = databaseProcess;
  const databaseLost = () => {
    if (!closing && databaseProcess === activeDatabase) {
      console.error('The private preview database stopped; shutting down the local app.');
      void cleanup(1);
    }
  };
  activeDatabase.once('exit', databaseLost);
  activeDatabase.once('error', databaseLost);
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (appProcess.exitCode !== null || appProcess.signalCode !== null) break;
    try {
      const response = await fetch(config.APP_URL + '/login', { redirect: 'manual', signal: AbortSignal.timeout(1000) });
      if (response.status === 200) { ready = true; break; }
    } catch {}
    await sleep(100);
  }
  if (!ready) throw new Error('The local owner sign-in preview did not become ready.');
  console.log('Local Hostinger preview: ' + config.APP_URL);
  console.log('Owner sign-in: ' + config.APP_URL + '/login');
  console.log('Private local setup notes: ' + accessFile);
  console.log('Private local settings: ' + configFile);
  if (!config.ADMIN_EMAIL) console.log('Set the fixed owner email privately in local settings before first setup.');
  if (!config.RESEND_API_KEY || !config.AUTH_EMAIL_FROM)
    console.log('Email delivery is not configured. Configure it privately before setup or recovery; email verification is never skipped.');
  await new Promise(resolve => appProcess.once('exit', resolve));
  await cleanup(appProcess.exitCode || 0);
}
main().catch(async error => {
  // SQL errors may contain parameter values. Print only our safe setup messages.
  const safe = ['Run npm run build:hostinger', 'Install MariaDB', 'Private local preview settings', 'A local preview launcher', 'The preview database', 'The private local database', 'The local owner sign-in'];
  console.error(safe.some(prefix => error.message?.startsWith(prefix)) ? error.message : 'Local Hostinger preview could not start. Check the private preview logs.');
  console.error('Private preview logs: ' + state);
  await cleanup(1);
});

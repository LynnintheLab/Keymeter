import { createHmac, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { getPool, lock, transaction } from './database.mjs';
import { requireConfig } from './config.mjs';

const derive = promisify(scrypt);
export const SESSION_TTL = 8 * 60 * 60;
export const REMEMBER_TTL = 7 * 24 * 60 * 60;
const loginWindow = 10_000;
const loginActorLimit = 6;
const loginGlobalLimit = 20;
const loginHashConcurrency = 2;
let activePasswordHashes = 0;

export async function passwordHash(password) {
  const salt = randomBytes(16).toString('base64url');
  const digest = await derive(password, salt, 32, { N: 32768, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${salt}$${digest.toString('base64url')}`;
}
export async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || password.length > 1024 || !/^scrypt\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/.test(encoded)) return false;
  const [, salt, expected] = encoded.split('$');
  const actual = await derive(password, salt, 32, { N: 32768, maxmem: 64 * 1024 * 1024 });
  return timingSafeEqual(Buffer.from(expected, 'base64url'), actual);
}
export async function ownerAccount(connection = getPool()) {
  const [rows] = await connection.execute('SELECT email, version, password_hash FROM owner_account WHERE id = 1');
  return rows[0] || null;
}
export function effectivePasswordHash(owner, config = requireConfig()) {
  // A generated or recovered database key always wins. An environment hash is
  // retained only for accounts created before database-backed owner keys.
  return owner?.password_hash ?? config.ADMIN_PASSWORD_HASH ?? '';
}
export function generateOwnerKey() {
  const groups = ['ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz', '0123456789', '!@#$%*-_+='];
  const alphabet = groups.join('');
  const values = groups.map(group => group[randomInt(group.length)]);
  while (values.length < 64) values.push(alphabet[randomInt(alphabet.length)]);
  for (let index = values.length - 1; index > 0; index--) {
    const other = randomInt(index + 1);
    [values[index], values[other]] = [values[other], values[index]];
  }
  return values.join('');
}
export function validOwnerEmail(value) {
  return typeof value === 'string' && value.length <= 254 && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value);
}
function sessionHash(token, owner) {
  const config = requireConfig();
  return createHmac('sha256', config.SESSION_SECRET)
    .update('keymeter:owner-session:email-v2\0').update(owner.email).update('\0').update(owner.version).update('\0')
    .update(effectivePasswordHash(owner, config)).update('\0').update(token).digest('hex');
}
export function cookieName() {
  return new URL(requireConfig().APP_URL).protocol === 'https:' ? '__Host-keymeter-session' : 'keymeter-session';
}
export function cookieHeader(token, clear = false, ttl = SESSION_TTL) {
  const secure = new URL(requireConfig().APP_URL).protocol === 'https:';
  return `${cookieName()}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : ttl}${secure ? '; Secure' : ''}`;
}
export function tokenFromCookie(header = '') {
  const prefix = cookieName() + '=';
  const matches = header.split(';').map(value => value.trim()).filter(value => value.startsWith(prefix));
  return matches.length === 1 ? matches[0].slice(prefix.length) : '';
}
export async function checkLogin(email, password, remoteAddress = 'unknown', now = Date.now()) {
  // Never queue unbounded memory-intensive hashes. Existing sessions do not use
  // this budget, and rejected bursts can retry within a few seconds.
  if (activePasswordHashes >= loginHashConcurrency) return { ok: false, limited: true, retryAfter: 2 };
  activePasswordHashes++;
  try {
    const config = requireConfig();
    const window = Math.floor(now / loginWindow);
    const resetAt = (window + 1) * loginWindow;
    const bucket = actor => createHmac('sha256', config.SESSION_SECRET)
      .update(`keymeter:owner-login:v2\0${window}\0${actor}`).digest('hex');
    const globalBucket = bucket('global');
    const actorBucket = bucket(`${remoteAddress}\0${String(email).trim().toLowerCase()}`);
    const allowed = await transaction(async connection => {
      await lock(connection, 'owner-login');
      await connection.execute('DELETE FROM request_limits WHERE reset_at < ?', [now]);
      const [counts] = await connection.execute('SELECT bucket_hash, request_count FROM request_limits WHERE bucket_hash IN (?, ?)', [globalBucket, actorBucket]);
      const count = id => Number(counts.find(row => row.bucket_hash === id)?.request_count || 0);
      if (count(globalBucket) >= loginGlobalLimit || count(actorBucket) >= loginActorLimit) return false;
      for (const id of [globalBucket, actorBucket])
        await connection.execute('INSERT INTO request_limits (bucket_hash, reset_at, request_count) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE request_count = request_count + 1', [id, resetAt]);
      return true;
    });
    if (!allowed) return { ok: false, limited: true, retryAfter: Math.max(1, Math.ceil((resetAt - now) / 1000)) };
    const owner = await ownerAccount();
    const validPassword = await verifyPassword(password, effectivePasswordHash(owner, config));
    const supplied = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const target = owner?.email || config.ADMIN_EMAIL?.trim().toLowerCase() || supplied;
    return { ok: validPassword && validOwnerEmail(supplied) && supplied === target, limited: false, email: target, ownerVersion: owner?.version || 'bootstrap' };
  } finally { activePasswordHashes--; }
}
export async function createSession(ttl = SESSION_TTL, now = Date.now(), connection = getPool()) {
  if (![SESSION_TTL, REMEMBER_TTL].includes(ttl)) throw new Error('Invalid owner session duration.');
  const owner = await ownerAccount(connection);
  if (!owner) throw new Error('Verified owner email is required.');
  const token = randomBytes(32).toString('base64url');
  await connection.execute('DELETE FROM auth_sessions WHERE expires_at <= ?', [now]);
  await connection.execute('INSERT INTO auth_sessions (token_hash, expires_at) VALUES (?, ?)', [sessionHash(token, owner), now + ttl * 1000]);
  return token;
}
export async function authenticatedOwner(token) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const owner = await ownerAccount();
  if (!owner) return null;
  const [rows] = await getPool().execute('SELECT token_hash FROM auth_sessions WHERE token_hash = ? AND expires_at > ?', [sessionHash(token, owner), Date.now()]);
  return rows.length ? { userId: 'hostinger-owner', email: owner.email } : null;
}
export async function deleteSession(token) {
  const owner = await ownerAccount();
  if (owner && /^[A-Za-z0-9_-]{43}$/.test(token)) await getPool().execute('DELETE FROM auth_sessions WHERE token_hash = ?', [sessionHash(token, owner)]);
}
export const FORM_TTL = 60 * 60;
export function formCookieName() {
  return new URL(requireConfig().APP_URL).protocol === 'https:' ? '__Host-keymeter-form' : 'keymeter-form';
}
function formNonce(headers) {
  const prefix = formCookieName() + '=';
  const values = String(headers.cookie || '').split(';').map(value => value.trim()).filter(value => value.startsWith(prefix));
  return values.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(values[0].slice(prefix.length)) ? values[0].slice(prefix.length) : '';
}
function formSignature(headers, nonce, issuedAt) {
  const config = requireConfig();
  // Bind the proof to this browser nonce and its current login/pre-login session.
  // JSON encoding is unambiguous; session credentials never appear in the form.
  return createHmac('sha256', config.SESSION_SECRET).update(JSON.stringify([
    'keymeter:form:v1', new URL(config.APP_URL).origin, nonce,
    tokenFromCookie(headers.cookie), preauthFromCookie(headers.cookie), issuedAt,
  ])).digest('base64url');
}
export function createFormProtection(headers, now = Date.now()) {
  const nonce = formNonce(headers) || randomBytes(32).toString('base64url');
  const issuedAt = String(Math.floor(now / 1000));
  const secure = new URL(requireConfig().APP_URL).protocol === 'https:';
  return {
    token: `${issuedAt}.${formSignature(headers, nonce, issuedAt)}`,
    cookie: `${formCookieName()}=${nonce}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${FORM_TTL}${secure ? '; Secure' : ''}`,
  };
}
export function verifiedForm(headers, token, now = Date.now()) {
  const origin = headers.origin;
  // Embedded browsers may omit Origin or send its opaque "null" value. They
  // still need the signed form proof and its matching HttpOnly browser cookie.
  if (origin !== undefined && origin !== 'null' && origin !== new URL(requireConfig().APP_URL).origin) return false;
  if (typeof token !== 'string' || !/^[0-9]{10}\.[A-Za-z0-9_-]{43}$/.test(token)) return false;
  const nonce = formNonce(headers);
  if (!nonce) return false;
  const [issuedAt, signature] = token.split('.');
  const age = Math.floor(now / 1000) - Number(issuedAt);
  if (age < 0 || age >= FORM_TTL) return false;
  return timingSafeEqual(Buffer.from(signature, 'base64url'), Buffer.from(formSignature(headers, nonce, issuedAt), 'base64url'));
}
export function sanitizedHeaders(headers, remoteAddress, owner) {
  const clean = {};
  const blocked = new Set(['host', 'forwarded', 'cf-connecting-ip', 'true-client-ip', 'x-real-ip', 'x-keymeter-client-ip', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
  for (const value of String(headers.connection ?? '').split(',')) blocked.add(value.trim().toLowerCase());
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!lower.startsWith('oai-') && !lower.startsWith('x-forwarded-') && !blocked.has(lower) && value !== undefined) clean[lower] = value;
  }
  const url = new URL(requireConfig().APP_URL);
  clean.host = url.host;
  clean['x-forwarded-proto'] = url.protocol.slice(0, -1);
  clean['x-keymeter-client-ip'] = remoteAddress || 'unknown';
  if (owner) {
    clean['oai-authenticated-user-id'] = owner.userId;
    clean['oai-authenticated-user-email'] = owner.email;
  }
  return clean;
}

export function preauthCookieName() {
  return new URL(requireConfig().APP_URL).protocol === 'https:' ? '__Host-keymeter-preauth' : 'keymeter-preauth';
}
export function preauthCookieHeader(token, clear = false) {
  const secure = new URL(requireConfig().APP_URL).protocol === 'https:';
  return `${preauthCookieName()}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : 300}${secure ? '; Secure' : ''}`;
}
export function preauthFromCookie(header = '') {
  const prefix = preauthCookieName() + '=';
  const matches = header.split(';').map(value => value.trim()).filter(value => value.startsWith(prefix));
  return matches.length === 1 ? matches[0].slice(prefix.length) : '';
}

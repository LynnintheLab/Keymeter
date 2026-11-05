import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

type Owner = { userId: string; email: string };
type AuthEnvironment = Pick<Cloudflare.Env, 'DB' | 'BILLING_ENCRYPTION_KEY' | 'KEYMETER_OWNER_ID' | 'KEYMETER_OWNER_EMAIL' | 'SELLER_AUTH_MODE'>;
type PasswordRow = { owner_hash: string; password_hash: string; version: string };
export type SellerAccess = 'setup' | 'locked' | 'unlocked';
export const SELLER_SESSION_SECONDS = 8 * 60 * 60;
export const SELLER_COOKIE = '__Host-keymeter-seller';
let hashing = false;

export class SellerAuthError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfter?: number) { super(message); }
}

export function sellerOwner(user: Owner | null, config: AuthEnvironment): user is Owner {
  return !!user && ((!!config.KEYMETER_OWNER_ID && user.userId === config.KEYMETER_OWNER_ID) ||
    (!!config.KEYMETER_OWNER_EMAIL && user.email.toLowerCase() === config.KEYMETER_OWNER_EMAIL.toLowerCase()));
}

// Only the standalone build's runtime alias supplies this constant. It is never
// read from a request header. That gateway already verifies its password cookie.
export function gatewayAuthenticated(config: AuthEnvironment) {
  return config.SELLER_AUTH_MODE === 'hostinger-gateway-v1';
}

function storage(config: AuthEnvironment) {
  if (!config.DB || !config.BILLING_ENCRYPTION_KEY ||
      !/^[A-Za-z0-9+/]{43}=$/.test(config.BILLING_ENCRYPTION_KEY))
    throw new SellerAuthError(503, 'Owner sign-in is temporarily unavailable.');
  return { db: config.DB, secret: config.BILLING_ENCRYPTION_KEY };
}

function digest(secret: string, context: string, value: string) {
  return createHmac('sha256', Buffer.from(secret, 'base64')).update(context).update('\0').update(value).digest('hex');
}
function ownerHash(secret: string, owner: Owner) {
  return digest(secret, 'keymeter:seller-owner:v1', owner.userId + '\0' + owner.email.toLowerCase());
}
function sessionHash(secret: string, token: string, owner: string, version: string) {
  return digest(secret, 'keymeter:seller-session:v1', owner + '\0' + version + '\0' + token);
}

export function sellerCookieHeader(token: string, clear = false) {
  return `${SELLER_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${clear ? 0 : SELLER_SESSION_SECONDS}`;
}
function cookieToken(header: string) {
  const values = header.split(';').map(part => part.trim()).filter(part => part.startsWith(SELLER_COOKIE + '='));
  if (values.length !== 1) return '';
  const value = values[0].slice(SELLER_COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : '';
}

export function sellerSameOrigin(request: Request, writing = request.method !== 'GET') {
  const origin = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return false;
  return writing ? origin === new URL(request.url).origin : !origin || origin === new URL(request.url).origin;
}

export async function sellerAccess(config: AuthEnvironment, owner: Owner, cookie = '', now = Date.now()): Promise<SellerAccess> {
  if (!sellerOwner(owner, config)) return 'locked';
  if (gatewayAuthenticated(config)) return 'unlocked';
  const { db, secret } = storage(config);
  const row = await db.prepare('SELECT owner_hash, password_hash, version FROM seller_password WHERE id = 1').first<PasswordRow>();
  if (!row) return 'setup';
  const identity = ownerHash(secret, owner);
  if (row.owner_hash !== identity) return 'locked';
  const token = cookieToken(cookie);
  if (!token) return 'locked';
  const session = await db.prepare('SELECT token_hash FROM seller_sessions WHERE token_hash = ? AND owner_hash = ? AND password_version = ? AND expires_at > ?')
    .bind(sessionHash(secret, token, identity, row.version), identity, row.version, now).first();
  return session ? 'unlocked' : 'locked';
}

export async function limitSellerPassword(request: Request, config: AuthEnvironment, owner: Owner, now = Date.now()) {
  const { db, secret } = storage(config);
  const window = Math.floor(now / 10_000);
  const resetAt = (window + 1) * 10_000;
  const address = request.headers.get('cf-connecting-ip') || request.headers.get('x-keymeter-client-ip') || 'unknown';
  const actors = [ownerHash(secret, owner), address];
  for (const [index, actor] of actors.entries()) {
    const hash = digest(secret, 'keymeter:seller-login-limit:v1', window + '\0' + index + '\0' + actor);
    const results = await db.batch<{ request_count: number }>([
      db.prepare('DELETE FROM request_limits WHERE reset_at < ?').bind(now - 120_000),
      db.prepare('INSERT INTO request_limits (bucket_hash, reset_at, request_count) VALUES (?, ?, 1) ON CONFLICT(bucket_hash) DO UPDATE SET request_count = request_count + 1').bind(hash, resetAt),
      db.prepare('SELECT request_count FROM request_limits WHERE bucket_hash = ?').bind(hash),
    ]);
    if (results[2].results[0]?.request_count > (index === 0 ? 4 : 10))
      throw new SellerAuthError(429, 'Too many sign-in attempts. Try again shortly.', Math.max(1, Math.ceil((resetAt - now) / 1000)));
  }
}

function validPassword(password: unknown): password is string {
  return typeof password === 'string' && password.length >= 16 && password.length <= 256 && password.trim().length >= 16;
}

async function derive(password: string, secret: string, salt: string) {
  if (hashing) throw new SellerAuthError(429, 'Sign-in is busy. Try again shortly.', 2);
  hashing = true;
  try {
    // Memory-bounded OWASP scrypt alternative. A server-secret pepper protects
    // password hashes in a database-only disclosure. No custom KDF or fallback.
    const peppered = digest(secret, 'keymeter:seller-password:v1', password);
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(peppered, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 },
        (error, result) => error ? reject(error) : resolve(result));
    });
  } finally { hashing = false; }
}

async function session(config: AuthEnvironment, owner: Owner, row: PasswordRow, now: number) {
  const { db, secret } = storage(config);
  const token = randomBytes(32).toString('base64url');
  const identity = ownerHash(secret, owner);
  await db.batch([
    db.prepare('DELETE FROM seller_sessions WHERE expires_at <= ?').bind(now),
    db.prepare('INSERT INTO seller_sessions (token_hash, owner_hash, password_version, expires_at) VALUES (?, ?, ?, ?)')
      .bind(sessionHash(secret, token, identity, row.version), identity, row.version, now + SELLER_SESSION_SECONDS * 1000),
  ]);
  return token;
}

export async function setupSellerPassword(config: AuthEnvironment, owner: Owner, password: unknown, now = Date.now()) {
  if (!sellerOwner(owner, config) || gatewayAuthenticated(config)) throw new SellerAuthError(403, 'Owner access is required.');
  if (!validPassword(password)) throw new SellerAuthError(400, 'Use a password or passphrase with 16–256 characters.');
  const { db, secret } = storage(config);
  const salt = randomBytes(16).toString('base64url');
  const encoded = `scrypt-v1$${salt}$${(await derive(password, secret, salt)).toString('base64url')}`;
  const row = { owner_hash: ownerHash(secret, owner), password_hash: encoded, version: randomBytes(16).toString('hex') };
  const saved = await db.prepare('INSERT OR IGNORE INTO seller_password (id, owner_hash, password_hash, version, created_at) VALUES (1, ?, ?, ?, ?)')
    .bind(row.owner_hash, row.password_hash, row.version, now).run();
  if (saved.meta.changes !== 1) throw new SellerAuthError(409, 'A billing password is already set. Sign in with it.');
  return session(config, owner, row, now);
}

export async function loginSellerPassword(config: AuthEnvironment, owner: Owner, password: unknown, now = Date.now()) {
  if (!sellerOwner(owner, config) || gatewayAuthenticated(config)) throw new SellerAuthError(403, 'Owner access is required.');
  const { db, secret } = storage(config);
  const row = await db.prepare('SELECT owner_hash, password_hash, version FROM seller_password WHERE id = 1').first<PasswordRow>();
  if (!row) throw new SellerAuthError(409, 'Set your billing password first.');
  const matches = /^scrypt-v1\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/.exec(row.password_hash);
  if (!matches || !validPassword(password) || row.owner_hash !== ownerHash(secret, owner))
    throw new SellerAuthError(401, 'The password is incorrect.');
  const result = await derive(password, secret, matches[1]);
  if (!timingSafeEqual(result, Buffer.from(matches[2], 'base64url')))
    throw new SellerAuthError(401, 'The password is incorrect.');
  return session(config, owner, row, now);
}

export async function logoutSellerPassword(config: AuthEnvironment, owner: Owner, cookie: string) {
  if (!sellerOwner(owner, config) || gatewayAuthenticated(config)) return;
  const { db, secret } = storage(config);
  const row = await db.prepare('SELECT owner_hash, password_hash, version FROM seller_password WHERE id = 1').first<PasswordRow>();
  const token = cookieToken(cookie);
  if (row && token) await db.prepare('DELETE FROM seller_sessions WHERE token_hash = ? AND owner_hash = ?')
    .bind(sessionHash(secret, token, ownerHash(secret, owner), row.version), ownerHash(secret, owner)).run();
}

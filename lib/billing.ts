import { KEY_RE, accountKeyIdentity, readLimited } from './quota';
import type { AccountKeyIdentity } from './quota';
import { providerNetworkFailure } from './provider-diagnostics';

export type BillingKey = { id: string; mask: string; name: string; userId: string };
export type TaskRecord = {
  taskId: string;
  time: string;
  name: string;
  status: string;
  cost: number | null;
  currency: string;
};
export type TaskHistory = {
  state: 'ready' | 'not_connected' | 'not_found' | 'reconnect' | 'unavailable';
  records: TaskRecord[];
  hasMore: boolean;
};
type Connection = { token: string; teamId: string; currency: string; refreshToken?: string; expiresAt?: number };
type SavedConnection = { encrypted_session: string };
type LoadedConnection = { value: Connection; ciphertext: string };
type ObjectRow = Record<string, unknown>;
const origin = 'https://www.runninghub.ai';
const decoder = new TextDecoder();
const encoder = new TextEncoder();

export class BillingError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const unavailable = () => new BillingError(502, 'RunningHub billing is unavailable. Try again shortly.');
const reconnect = () => new BillingError(401, 'Reconnect the RunningHub seller session.');
const object = (value: unknown): value is ObjectRow => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
function base64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}
function bytes(value: string) {
  return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}
async function encryptionKey(secret: string | undefined) {
  if (!secret) throw new BillingError(503, 'Seller billing setup is unavailable.');
  const raw = bytes(secret);
  if (raw.length !== 32) throw new BillingError(503, 'Seller billing setup is unavailable.');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function encrypt(connection: Connection, secret: string | undefined) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv,
    additionalData: encoder.encode('keymeter:billing-session:v1') }, await encryptionKey(secret), encoder.encode(JSON.stringify(connection)));
  return base64(iv) + '.' + base64(new Uint8Array(ciphertext));
}
async function decrypt(value: string, secret: string | undefined): Promise<Connection> {
  const [iv, ciphertext] = value.split('.');
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(iv),
    additionalData: encoder.encode('keymeter:billing-session:v1') }, await encryptionKey(secret), bytes(ciphertext));
  const result = JSON.parse(decoder.decode(plaintext));
  if (!object(result) || typeof result.token !== 'string' || typeof result.teamId !== 'string' || typeof result.currency !== 'string') throw unavailable();
  return result as Connection;
}
async function provider(path: '/api/key/queryAllV2' | '/api/key/list' | '/api/billing/usage/wideDetails' | '/uc/getUserInfo' | '/uc/team/wallet/current-subject-balance' | '/uc/token/refresh', connection: Connection,
  body: ObjectRow, transport: typeof fetch = fetch): Promise<unknown> {
  let response;
  try {
    const isTeamWallet = path === '/uc/team/wallet/current-subject-balance';
    const url = origin + path + (isTeamWallet ? '?teamId=' + encodeURIComponent(connection.teamId) : '');
    response = await transport(url, {
      method: isTeamWallet ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json',
        Authorization: 'Bearer ' + connection.token, ...(connection.teamId ? { 'X-Team-Id': connection.teamId } : {}) },
      body: isTeamWallet ? undefined : JSON.stringify(body), redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(10000),
    });
  } catch (error) { providerNetworkFailure('billing', error); throw unavailable(); }
  if (response.status === 401 || response.status === 403) throw reconnect();
  if (response.status === 429) throw new BillingError(429, 'RunningHub billing is busy. Wait a moment and retry.');
  if (!response.ok) throw unavailable();
  let envelope;
  try { envelope = JSON.parse(await readLimited(response.body, 2_000_000)); } catch { throw unavailable(); }
  if (!object(envelope)) throw unavailable();
  if (String(envelope.code) === '412' || (String(envelope.code) === '403' &&
      (envelope.msg === 'TOKEN_MISSION' || envelope.msg === 'TOKEN_INVALID'))) throw reconnect();
  if (String(envelope.code) !== '0') throw unavailable();
  return envelope.data;
}
export function parseSellerKeys(value: unknown): BillingKey[] {
  if (!object(value) || !Array.isArray(value.SHARED) || value.SHARED.length > 500) throw unavailable();
  return value.SHARED.map(row => {
    if (!object(row) || !id(row.apiKeyId) || typeof row.mask !== 'string') throw unavailable();
    return { id: id(row.apiKeyId), mask: row.mask, name: typeof row.apiKeyName === 'string' ? row.apiKeyName.slice(0, 120) : '', userId: id(row.userId) };
  });
}
async function sellerKeys(connection: Connection, transport: typeof fetch) {
  return parseSellerKeys(await provider('/api/key/queryAllV2', connection, {}, transport));
}
async function sellerCurrency(connection: Connection, keys: BillingKey[], transport: typeof fetch) {
  const personalUserId = sessionSubject(connection.token) || keys.find(entry => entry.userId)?.userId;
  if (!connection.teamId && !personalUserId) throw new BillingError(422, 'RunningHub did not identify the seller account for currency verification.');
  const walletResponse = connection.teamId
    ? await provider('/uc/team/wallet/current-subject-balance', connection, {}, transport)
    : await provider('/uc/getUserInfo', connection, { userId: personalUserId }, transport);
  const wallet = object(walletResponse) && connection.teamId ? walletResponse : object(walletResponse) ? walletResponse.walletInfo : null;
  if (!object(wallet) || typeof wallet.currency !== 'string' || !/^[A-Z]{3}$/.test(wallet.currency) ||
      (connection.teamId && wallet.teamId != null && id(wallet.teamId) !== connection.teamId))
    throw new BillingError(422, 'RunningHub did not identify the billing currency.');
  return wallet.currency;
}
function sessionSubject(token: string) {
  try {
    const payload = token.split('.')[1];
    if (!payload || !/^[A-Za-z0-9_-]+$/.test(payload)) return '';
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(decoder.decode(bytes(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))));
    if (!object(claims)) return '';
    // The provider already authenticated this session. Its subject only selects
    // the provider-authorized account-info query, never local seller access.
    if (typeof claims.sub === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(claims.sub)) return claims.sub;
    return typeof claims.sub === 'number' && Number.isSafeInteger(claims.sub) && claims.sub >= 0 ? String(claims.sub) : '';
  } catch {
    return '';
  }
}
function sessionExpiry(connection: Connection): number | null {
  try {
    const payload = connection.token.split('.')[1];
    if (payload) {
      const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
      const claims = JSON.parse(decoder.decode(bytes(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))));
      if (object(claims) && typeof claims.exp === 'number' && Number.isSafeInteger(claims.exp) && claims.exp > 0)
        return claims.exp * 1000;
    }
  } catch { /* Opaque access tokens can use the provider's renewal expiry. */ }
  return typeof connection.expiresAt === 'number' && Number.isFinite(connection.expiresAt) ? connection.expiresAt : null;
}
function sessionMetadata(connection: Connection) {
  const expiresAt = sessionExpiry(connection);
  return { expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(), canRenew: !!connection.refreshToken };
}
function cleanToken(value: unknown): string {
  const token = typeof value === 'string' ? value.trim().replace(/^Bearer\s+/i, '') : '';
  if (token.length < 20 || token.length > 8192 || /\s/.test(token))
    throw new BillingError(400, 'Enter the seller session token from RunningHub.');
  return token;
}
function matchKey(mask: string, key: string) {
  if (mask === key) return true;
  const parts = /^([a-zA-Z0-9_-]{4,})\*+([a-zA-Z0-9_-]{4,})$/.exec(mask);
  return !!parts && parts[1].length + parts[2].length < key.length && key.startsWith(parts[1]) && key.endsWith(parts[2]);
}
function requireDb(db: D1Database | undefined): D1Database {
  if (!db) throw new BillingError(503, 'Seller billing storage is unavailable.');
  return db;
}
async function connectionFrom(db: D1Database, secret: string | undefined) {
  const saved = await db.prepare('SELECT encrypted_session FROM billing_connection WHERE id = 1').first<SavedConnection>();
  return saved ? { value: await decrypt(saved.encrypted_session, secret), ciphertext: saved.encrypted_session } : null;
}
function refreshedConnection(connection: Connection, data: unknown): Connection {
  if (!object(data) || typeof data.access_token !== 'string') throw unavailable();
  const next: Connection = { ...connection, token: cleanToken(data.access_token), expiresAt: undefined,
    refreshToken: data.refresh_token == null ? connection.refreshToken : cleanToken(data.refresh_token) };
  // RunningHub's website adds expire_in directly to Date.now(), in milliseconds.
  if (typeof data.expire_in === 'number' || typeof data.expire_in === 'string') {
    const duration = Number(data.expire_in);
    if (Number.isSafeInteger(duration) && duration > 0 && duration <= 366 * 86_400_000)
      next.expiresAt = Date.now() + duration;
  }
  return next;
}
async function saveRenewal(db: D1Database, loaded: LoadedConnection, next: Connection,
  secret: string | undefined, lockUntil: number): Promise<LoadedConnection> {
  const ciphertext = await encrypt(next, secret);
  const updatedAt = new Date().toISOString();
  const save = () => db.prepare(`UPDATE billing_connection SET encrypted_session = ?, updated_at = ?, refresh_lock_until = 0
    WHERE id = 1 AND encrypted_session = ? AND refresh_lock_until = ?`)
    .bind(ciphertext, updatedAt, loaded.ciphertext, lockUntil).run();
  let saved;
  try { saved = await save(); }
  catch {
    // A provider may already have rotated its refresh token. Retry this exact
    // ciphertext once; never repeat the provider refresh or overwrite a new row.
    saved = await save();
  }
  if (saved.meta.changes === 1) return { value: next, ciphertext };
  const current = await connectionFrom(db, secret);
  if (!current) throw reconnect();
  if (current.ciphertext === ciphertext) return { value: next, ciphertext };
  return current;
}
async function renewConnection(db: D1Database, loaded: LoadedConnection, secret: string | undefined,
  transport: typeof fetch): Promise<LoadedConnection> {
  if (!loaded.value.refreshToken) throw reconnect();
  const lockUntil = Date.now() + 30_000;
  const acquired = await db.prepare(`UPDATE billing_connection SET refresh_lock_until = ?
    WHERE id = 1 AND encrypted_session = ? AND refresh_lock_until <= ? RETURNING id`)
    .bind(lockUntil, loaded.ciphertext, Date.now()).first<{ id: number }>();
  if (!acquired) {
    const current = await connectionFrom(db, secret);
    if (current && current.ciphertext !== loaded.ciphertext) return current;
    throw new BillingError(503, 'The saved seller session is renewing. Try again shortly.');
  }
  try {
    const data = await provider('/uc/token/refresh', { ...loaded.value, token: loaded.value.refreshToken }, {}, transport);
    const next = refreshedConnection(loaded.value, data);
    const renewedKeys = await sellerKeys(next, transport);
    const originalSubject = sessionSubject(loaded.value.token);
    const renewedSubject = sessionSubject(next.token);
    // A refresh pasted for another account must never replace the saved seller.
    // The old subject is trusted only because the original token was provider-
    // authenticated before storage; authenticate the replacement before using it.
    if (originalSubject && renewedSubject) {
      if (originalSubject !== renewedSubject) throw reconnect();
    } else if (!sameRoster(await sellerKeys(loaded.value, transport), renewedKeys)) {
      throw reconnect();
    }
    if (await sellerCurrency(next, renewedKeys, transport) !== loaded.value.currency) throw reconnect();
    return await saveRenewal(db, loaded, next, secret, lockUntil);
  } catch (error) {
    // Keep the stored credentials. The short lock also backs off transient failures.
    if (error instanceof BillingError && error.status === 401) {
      await db.prepare('UPDATE billing_connection SET refresh_lock_until = 0 WHERE id = 1 AND encrypted_session = ? AND refresh_lock_until = ?')
        .bind(loaded.ciphertext, lockUntil).run();
    }
    throw error;
  }
}
function sameRoster(left: BillingKey[], right: BillingKey[]) {
  const canonical = (keys: BillingKey[]) => {
    if (!keys.length || new Set(keys.map(key => key.id)).size !== keys.length) return null;
    return JSON.stringify(keys.map(key => [key.id, key.mask]).sort(([a], [b]) => a.localeCompare(b)));
  };
  const original = canonical(left);
  return original !== null && original === canonical(right);
}

export async function addSellerRefreshToken(dbInput: D1Database | undefined, secret: string | undefined,
  refreshInput: unknown, transport: typeof fetch = fetch) {
  const db = requireDb(dbInput);
  const suppliedRefresh = cleanToken(refreshInput);
  const loaded = await connectionFrom(db, secret);
  if (!loaded) throw new BillingError(409, 'Connect RunningHub before adding automatic renewal.');
  // The original subject came from an access token authenticated before storage.
  // If that access has expired, only that encrypted immutable subject can prove
  // continuity; opaque or subjectless sessions must use a full reconnect.
  const originalSubject = sessionSubject(loaded.value.token);
  let originalKeys: BillingKey[] | null;
  try { originalKeys = await sellerKeys(loaded.value, transport); }
  catch (error) {
    if (!(error instanceof BillingError) || error.status !== 401 || !originalSubject) throw error;
    originalKeys = null;
  }
  const lockUntil = Date.now() + 45_000;
  const acquired = await db.prepare(`UPDATE billing_connection SET refresh_lock_until = ?
    WHERE id = 1 AND encrypted_session = ? AND refresh_lock_until <= ? RETURNING id`)
    .bind(lockUntil, loaded.ciphertext, Date.now()).first<{ id: number }>();
  if (!acquired) throw new BillingError(503, 'The saved seller session is updating. Try again shortly.');
  try {
    const data = await provider('/uc/token/refresh', { ...loaded.value, token: suppliedRefresh }, {}, transport);
    const next = refreshedConnection({ ...loaded.value, refreshToken: suppliedRefresh }, data);
    const refreshedKeys = await sellerKeys(next, transport);
    const refreshedSubject = sessionSubject(next.token);
    if (!(originalKeys ? sameRoster(originalKeys, refreshedKeys) : sameRoster(refreshedKeys, refreshedKeys)) ||
        ((originalSubject || refreshedSubject) && originalSubject !== refreshedSubject))
      throw new BillingError(422, 'The refresh token could not be verified for the saved RunningHub account.');
    next.currency = await sellerCurrency(next, refreshedKeys, transport);
    if (next.currency !== loaded.value.currency)
      throw new BillingError(422, 'The refresh token did not match the saved RunningHub billing currency.');
    const saved = await saveRenewal(db, loaded, next, secret, lockUntil);
    if (saved.value !== next)
      throw new BillingError(409, 'The connection changed while renewal was being enabled. Refresh this page.');
  } catch (error) {
    await db.prepare('UPDATE billing_connection SET refresh_lock_until = 0 WHERE id = 1 AND encrypted_session = ? AND refresh_lock_until = ?')
      .bind(loaded.ciphertext, lockUntil).run();
    throw error;
  }
}
async function withConnection<T>(db: D1Database, secret: string | undefined, transport: typeof fetch,
  action: (connection: Connection) => Promise<T>) {
  let loaded = await connectionFrom(db, secret);
  if (!loaded) return null;
  let attemptedRenewal = false;
  let deferredRenewalError: unknown;
  const expiresAt = sessionExpiry(loaded.value);
  if (loaded.value.refreshToken && expiresAt !== null && expiresAt <= Date.now() + 600_000) {
    attemptedRenewal = true;
    try { loaded = await renewConnection(db, loaded, secret, transport); }
    catch (error) {
      // A failed early renewal must not interrupt an access token that still works.
      if (expiresAt <= Date.now()) throw error;
      deferredRenewalError = error;
    }
  }
  try { return { result: await action(loaded.value), connection: loaded.value }; }
  catch (error) {
    if (!(error instanceof BillingError) || error.status !== 401 || !loaded.value.refreshToken) throw error;
    if (attemptedRenewal) {
      const current = await connectionFrom(db, secret);
      if (current && current.ciphertext !== loaded.ciphertext)
        return { result: await action(current.value), connection: current.value };
      if (deferredRenewalError instanceof BillingError && deferredRenewalError.status !== 401)
        throw unavailable();
      throw error;
    }
    loaded = await renewConnection(db, loaded, secret, transport);
    return { result: await action(loaded.value), connection: loaded.value };
  }
}
export async function sellerStatus(dbInput: D1Database | undefined, secret: string | undefined, transport: typeof fetch = fetch) {
  const db = requireDb(dbInput);
  const connection = await connectionFrom(db, secret);
  if (!connection) return { connected: false, keys: [], keyCount: 0, expiresAt: null, canRenew: false };
  try {
    const checked = await withConnection(db, secret, transport, connection => sellerKeys(connection, transport));
    if (!checked) return { connected: false, keys: [], keyCount: 0, expiresAt: null, canRenew: false };
    const keys = checked.result;
    return { connected: true, keys: keys.map(({ id, mask, name }) => ({ id, mask, name })), keyCount: keys.length, ...sessionMetadata(checked.connection) };
  } catch (error) {
    if (error instanceof BillingError && error.status === 401) return { connected: false, reconnect: true, keys: [], keyCount: 0, ...sessionMetadata(connection.value) };
    return { connected: true, unavailable: true, keys: [], keyCount: 0, ...sessionMetadata(connection.value) };
  }
}
export async function connectSeller(dbInput: D1Database | undefined, secret: string | undefined, tokenInput: unknown,
  teamInput: unknown, transport: typeof fetch = fetch, refreshInput?: unknown) {
  const db = requireDb(dbInput);
  const token = cleanToken(tokenInput);
  const teamId = typeof teamInput === 'string' ? teamInput.trim() : '';
  if (teamId.length > 100 || /[\r\n]/.test(teamId))
    throw new BillingError(400, 'Enter the seller session token from RunningHub.');
  const connection: Connection = { token, teamId, currency: '' };
  if (typeof refreshInput === 'string' && refreshInput.trim()) connection.refreshToken = cleanToken(refreshInput);
  const keys = await sellerKeys(connection, transport);
  if (keys.length === 0) throw new BillingError(422, 'This seller account has no Enterprise-Shared keys.');
  connection.currency = await sellerCurrency(connection, keys, transport);
  const ciphertext = await encrypt(connection, secret);
  await db.prepare('INSERT INTO billing_connection (id, encrypted_session, updated_at, refresh_lock_until) VALUES (1, ?, ?, 0) ON CONFLICT(id) DO UPDATE SET encrypted_session = excluded.encrypted_session, updated_at = excluded.updated_at, refresh_lock_until = 0')
    .bind(ciphertext, new Date().toISOString()).run();
}

// A valid caller key must identify the same complete account roster as the seller.
// A matching suffix, a guessed mask, or an arbitrary customer-supplied ID is insufficient.
function resolveAccountKey(value: unknown, identity: AccountKeyIdentity[], key: string) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500 || identity.length !== value.length) throw unavailable();
  const remaining = [...identity];
  let selected: { id: string; mask: string } | null = null;
  for (const row of value) {
    if (!object(row) || !id(row.apiKeyId) || typeof row.createdAt !== 'string') throw unavailable();
    const time = Date.parse(row.createdAt);
    if (!Number.isFinite(time)) throw unavailable();
    const normalized = accountKeyIdentity(row.key, row.createdAt);
    if (!normalized && !(row.key == null && row.isSystemAuto === true)) throw unavailable();
    const matches = remaining.map((entry, index) => ({ entry, index })).filter(({ entry }) =>
      entry.createdAt === new Date(time).toISOString() && (!normalized || entry.mask === normalized.mask));
    if (matches.length !== 1) throw unavailable();
    remaining.splice(matches[0].index, 1);
    const resolvedMask = typeof row.key === 'string' ? row.key : matches[0].entry.mask;
    if (matchKey(resolvedMask, key)) {
      if (selected) throw unavailable();
      selected = { id: id(row.apiKeyId), mask: resolvedMask };
    }
  }
  return selected;
}
export async function disconnectSeller(dbInput: D1Database | undefined) {
  const db = requireDb(dbInput);
  await db.batch([db.prepare('DELETE FROM billing_connection'), db.prepare('DELETE FROM billing_enrollment')]);
}
function timestamp(value: unknown) {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^\d{13}$/.test(value) ? Number(value) : typeof value === 'string' ? Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value) ? value.replace(' ', 'T') + '+08:00' : value) : NaN;
  if (!Number.isFinite(parsed)) throw unavailable();
  return new Date(parsed).toISOString();
}
function cost(value: unknown) {
  if (value == null) return null;
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^\d{1,9}(?:\.\d{1,6})?$/.test(String(value))) throw unavailable();
  return Number(value);
}
function currencyCode(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) throw unavailable();
  return value;
}
export function projectTasks(value: unknown, apiKeyId: string, currency: string, fullKey = '', enrolledMask = ''): TaskHistory {
  if (!object(value) || !Array.isArray(value.records) || value.records.length > 200 || typeof value.hasNext !== 'boolean') throw unavailable();
  const reportedCurrency = currencyCode(value.currency === undefined ? currency : value.currency);
  const records: TaskRecord[] = [];
  const seen = new Set<string>();
  for (const row of value.records) {
    if (!object(row) || !id(row.taskId)) throw unavailable();
    const rawKey = row.apiKey ?? row.apikey ?? row.api_key ?? row.apiKeyValue ?? row.apiKeyCode;
    const attributed = row.apiKeyId != null ? id(row.apiKeyId) === apiKeyId
      : typeof rawKey === 'string' && fullKey !== '' && (rawKey === fullKey || (enrolledMask !== '' && rawKey === enrolledMask));
    if (!attributed) throw unavailable();
    if (row.parentTaskId || row.taskRelation === 'CHILD') continue;
    if (seen.has(id(row.taskId))) throw unavailable();
    seen.add(id(row.taskId));
    records.push({ taskId: id(row.taskId), time: timestamp(row.createTime),
      name: typeof row.taskName === 'string' ? row.taskName.slice(0, 180) : typeof row.skuName === 'string' ? row.skuName.slice(0, 180) : 'API task',
      status: id(row.taskStatus) || 'Unknown', cost: cost(row.moneyAmount ?? row.finalMoneyAmount ?? row.amount),
      // Uncharged jobs can omit row currency. The authenticated billing page's
      // verified currency still applies; a nonempty malformed value is rejected.
      currency: row.currency == null || row.currency === '' ? reportedCurrency : currencyCode(row.currency) });
  }
  return { state: 'ready', records: records.slice(0, 50), hasMore: value.hasNext || records.length > 50 };
}
export async function readTaskHistory(dbInput: D1Database | undefined, key: string, secret: string | undefined,
  transport: typeof fetch = fetch, now = new Date(), identity: AccountKeyIdentity[] = []): Promise<TaskHistory> {
  const empty = (state: TaskHistory['state']): TaskHistory => ({ state, records: [], hasMore: false });
  if (!dbInput || !secret) return empty('not_connected');
  if (!KEY_RE.test(key)) return empty('not_found');
  try {
    const checked = await withConnection(dbInput, secret, transport, async connection => {
      const accountRows = await provider('/api/key/list', connection, { type: 'SHARED' }, transport);
      const selected = resolveAccountKey(accountRows, identity, key);
      if (!selected) return empty('not_found');
      const date = (instant: Date) => new Date(instant.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const data = await provider('/api/billing/usage/wideDetails', connection, {
        startDateTime: date(new Date(now.getTime() - 29 * 86400000)) + ' 00:00:00',
        endDateTime: date(now) + ' 23:59:59', apiKeyType: 2, apiKeyId: selected.id,
        size: 50, includeStats: false, includeChildTasks: false,
      }, transport);
      return projectTasks(data, selected.id, connection.currency, key, selected.mask);
    });
    return checked?.result ?? empty('not_connected');
  } catch (error) {
    return empty(error instanceof BillingError && error.status === 401 ? 'reconnect' : 'unavailable');
  }
}

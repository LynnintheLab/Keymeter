import { providerNetworkFailure } from './provider-diagnostics';

// Read-only quota lookup. Never substitute the account wallet for a key limit.
export const KEY_RE = /^[a-zA-Z0-9_-]{32,128}$/;
const endpoint = 'https://www.runninghub.ai/openapi/v2/api-key/list';
type Row = Record<string, unknown>;
export type Allowance = {
  limit: number | null;
  used: number;
  remaining: number | null;
  state: 'reported' | 'exhausted' | 'expired';
  checkedAt: string;
  suffix: string;
};
export class LookupError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const unavailable = () =>
  new LookupError(
    502,
    'RunningHub did not return a usable per-key allowance. No account balance has been substituted.',
  );
const denied = () =>
  new LookupError(
    403,
    'RunningHub did not allow this key to read its quota. Check that it is the complete Enterprise-Shared key, or ask your seller to enable lookup for it.',
  );
function match(value: unknown, key: string) {
  if (typeof value !== 'string') return false;
  if (value === key) return true;
  const parts = /^([A-Za-z0-9_-]{4,})\*+([A-Za-z0-9_-]{4,})$/.exec(value);
  return (
    !!parts &&
    parts[1].length + parts[2].length < key.length &&
    key.startsWith(parts[1]) &&
    key.endsWith(parts[2])
  );
}
function amount(value: unknown) {
  if (typeof value !== 'string' && typeof value !== 'number')
    throw unavailable();
  const decimal = String(value);
  if (!/^\d{1,9}(?:\.\d{1,6})?$/.test(decimal)) throw unavailable();
  const [whole, fraction = ''] = decimal.split('.');
  return Number(whole) * 1e6 + Number(fraction.padEnd(6, '0'));
}
export function projectAllowance(
  rows: unknown,
  key: string,
  now = new Date(),
): Allowance {
  if (!Array.isArray(rows)) throw unavailable();
  const matches = rows.filter(
    (row): row is Row => row && typeof row === 'object' && match(row.key, key),
  );
  if (matches.length !== 1)
    throw new LookupError(
      422,
      'RunningHub did not identify exactly one matching key. No balance can be shown.',
    );
  const row = matches[0];
  const limit = row.quotaLimit === null ? null : amount(row.quotaLimit);
  const used = amount(row.quotaUsed);
  const expires =
    row.expireAt == null
      ? null
      : typeof row.expireAt === 'string'
        ? Date.parse(row.expireAt)
        : NaN;
  if (expires !== null && !Number.isFinite(expires)) throw unavailable();
  const expired = expires !== null && expires <= now.getTime();
  const state = expired
    ? 'expired'
    : limit !== null && used >= limit
      ? 'exhausted'
      : 'reported';
  return {
    limit: limit === null ? null : limit / 1e6,
    used: used / 1e6,
    remaining: limit === null ? null : Math.max(0, limit - used) / 1e6,
    state,
    checkedAt: now.toISOString(),
    suffix: key.slice(-4),
  };
}
export async function readLimited(
  body: ReadableStream<Uint8Array> | null,
  max: number,
) {
  if (!body) throw new Error('Empty body');
  const reader = body.getReader();
  const decode = new TextDecoder();
  let bytes = 0,
    value = '';
  try {
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      bytes += chunk.length;
      if (bytes > max) {
        await reader.cancel();
        throw new Error('Body too large');
      }
      value += decode.decode(chunk, { stream: true });
    }
    return value + decode.decode();
  } finally {
    reader.releaseLock();
  }
}
export async function lookupAccount(
  key: string,
  config: { ownerKey?: string; registered?: string } = {},
  transport: typeof fetch = fetch,
) {
  if (!KEY_RE.test(key))
    throw new LookupError(
      400,
      'Enter the full key, not the masked version with stars.',
    );
  // Always try the customer's own full key first. A stale optional operator
  // credential must never block a key that can read its own allowance.
  try { return await requestAccount(key, key, transport); }
  catch (error) {
    if (!(error instanceof LookupError) || ![401, 403, 422].includes(error.status)) throw error;
    // An operator credential is a fallback only for an explicitly enrolled FULL
    // key. A suffix, mask, email or display name is never authorization.
    if (!config.ownerKey || !config.registered || config.ownerKey === key) throw error;
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))),
      n => n.toString(16).padStart(2, '0')).join('');
    if (!config.registered.split(/[\s,]+/).includes(digest)) throw error;
    return requestAccount(key, config.ownerKey, transport);
  }
}

async function requestAccount(key: string, credential: string, transport: typeof fetch) {
  let response: Response;
  try {
    response = await transport(endpoint, {
      method: 'GET',
      headers: {
        Authorization: 'Bearer ' + credential,
        Accept: 'application/json',
      },
      // workerd accepts manual/follow. Never forward an API key to a redirect.
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    providerNetworkFailure('quota', error);
    throw new LookupError(
      503,
      'This server could not reach RunningHub. Seller sign-in is not required for balance checks. Please try again shortly.',
    );
  }
  if (response.status === 429)
    throw new LookupError(
      429,
      'RunningHub is receiving too many requests. Wait a moment and retry.',
    );
  if (response.status === 401 || response.status === 403) throw denied();
  if (!response.ok) throw unavailable();
  let result;
  try {
    result = JSON.parse(await readLimited(response.body, 2_000_000));
  } catch {
    throw unavailable();
  }
  if (!result || typeof result !== 'object' || !Object.hasOwn(result, 'code'))
    throw unavailable();
  if (result.code !== 0 && result.code !== '0') {
    if (String(result.code) === '806' && result.msg === 'APIKEY_USER_NOT_FOUND')
      throw credential === key
        ? new LookupError(401, 'RunningHub did not recognize this key on its international service. Check that it is the current full key from runninghub.ai.')
        : new LookupError(403, 'The seller’s lookup credential was not recognized by RunningHub. Ask the seller to update the checker.');
    // A nonzero business code is not necessarily an invalid key.
    throw new LookupError(422, 'RunningHub received the request but did not provide this key’s quota. If the key works for jobs, ask the seller to check its quota permissions.');
  }
  const allowance = projectAllowance(result.data, key);
  const entries = (result.data as Row[]).map(row => accountKeyIdentity(row.key, row.createdAt));
  const identity = entries.every(entry => entry !== null) ? entries as AccountKeyIdentity[] : [];
  return { allowance, identity };
}

export type AccountKeyIdentity = { mask: string; createdAt: string };

// Compare immutable account-key metadata without keeping full credentials.
export function accountKeyIdentity(value: unknown, createdAt: unknown): AccountKeyIdentity | null {
  if (typeof value !== 'string' || typeof createdAt !== 'string') return null;
  if (!KEY_RE.test(value) && !/^[A-Za-z0-9_-]{4,}\*+[A-Za-z0-9_-]{4,}$/.test(value)) return null;
  const time = Date.parse(createdAt);
  if (!Number.isFinite(time)) return null;
  return { mask: value.slice(0, 4) + '*' + value.slice(-4), createdAt: new Date(time).toISOString() };
}

export async function lookup(
  key: string,
  config: { ownerKey?: string; registered?: string } = {},
  transport: typeof fetch = fetch,
) {
  return (await lookupAccount(key, config, transport)).allowance;
}

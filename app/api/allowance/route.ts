import { env } from 'cloudflare:workers';
import { readTaskHistory } from '@/lib/billing';
import { recordCheck } from '@/lib/history';
import { limitRequest, RequestLimitError } from '@/lib/request-limit';
import { LookupError, lookupAccount, readLimited } from '@/lib/quota';
export const dynamic = 'force-dynamic';
const headers = {
  'Cache-Control': 'private, no-store, max-age=0',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};
const fail = (message: string, status: number) =>
  Response.json({ error: message }, { status, headers });
export async function POST(request: Request) {
  if (
    request.headers.get('sec-fetch-site') === 'cross-site' ||
    (request.headers.has('origin') &&
      request.headers.get('origin') !== new URL(request.url).origin)
  )
    return fail('Use the checker on this site.', 403);
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json')
    return fail('Expected a JSON request.', 415);
  let input;
  try {
    input = JSON.parse(await readLimited(request.body, 1024));
  } catch {
    return fail('Invalid request.', 400);
  }
  if (typeof input?.key !== 'string')
    return fail('Enter the full Enterprise-Shared key.', 400);
  try {
    const key = input.key.trim();
    await limitRequest(request, env.DB, 'allowance', key);
    const { allowance: result, identity } = await lookupAccount(key, {
      ownerKey: env.RUNNINGHUB_OWNER_KEY,
      registered: env.REGISTERED_KEY_HASHES,
    });
    const [history, tasks] = await Promise.all([
      recordCheck(env.DB, key, result),
      readTaskHistory(env.DB, key, env.BILLING_ENCRYPTION_KEY, undefined, undefined, identity),
    ]);
    return Response.json({ ...result, history, tasks }, { headers });
  } catch (e) {
    if (e instanceof RequestLimitError)
      return Response.json({ error: e.message }, { status: e.status, headers: { ...headers, 'Retry-After': String(e.retryAfter) } });
    return e instanceof LookupError
      ? fail(e.message, e.status)
      : fail('Quota lookup unavailable. Please try again.', 503);
  }
}

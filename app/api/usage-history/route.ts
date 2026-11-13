import { env } from 'cloudflare:workers';
import { KEY_RE, readLimited } from '@/lib/quota';
import { limitRequest, RequestLimitError } from '@/lib/request-limit';
import { lookupUsageHistory } from '@/lib/usage-history';

export const dynamic = 'force-dynamic';
const headers = {
  'Cache-Control': 'private, no-store, max-age=0',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};
const fail = (error: string, status: number) => Response.json({ error }, { status, headers });

export async function POST(request: Request) {
  if (request.headers.get('sec-fetch-site') === 'cross-site' ||
      (request.headers.has('origin') && request.headers.get('origin') !== new URL(request.url).origin))
    return fail('Use the checker on this site.', 403);
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json')
    return fail('Expected a JSON request.', 415);
  let input;
  try { input = JSON.parse(await readLimited(request.body, 1024)); }
  catch { return fail('Invalid request.', 400); }
  const key = typeof input?.key === 'string' ? input.key.trim() : '';
  if (!KEY_RE.test(key)) return fail('Enter the full Enterprise-Shared key.', 400);
  try {
    await limitRequest(request, env.DB, 'usage-history', key);
    const tasks = await lookupUsageHistory(env.DB, key, env.BILLING_ENCRYPTION_KEY, {
      ownerKey: env.RUNNINGHUB_OWNER_KEY,
      registered: env.REGISTERED_KEY_HASHES,
    });
    return Response.json(tasks, { headers });
  } catch (error) {
    if (error instanceof RequestLimitError)
      return Response.json({ error: error.message }, { status: error.status,
        headers: { ...headers, 'Retry-After': String(error.retryAfter) } });
    return Response.json({ state: 'unavailable', records: [], hasMore: false }, { headers });
  }
}

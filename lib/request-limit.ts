export class RequestLimitError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfter = 60) {
    super(message);
  }
}

async function consume(db: D1Database, scope: string, actor: string, limit: number, now: number) {
  const window = Math.floor(now / 60_000);
  const digest = await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(`keymeter:request-limit:v1\0${scope}\0${actor}\0${window}`));
  const bucket = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const results = await db.batch<{ request_count: number }>([
    db.prepare('DELETE FROM request_limits WHERE reset_at < ?').bind(now - 120_000),
    db.prepare('INSERT INTO request_limits (bucket_hash, reset_at, request_count) VALUES (?, ?, 1) ON CONFLICT(bucket_hash) DO UPDATE SET request_count = request_count + 1')
      .bind(bucket, (window + 1) * 60_000),
    db.prepare('SELECT request_count FROM request_limits WHERE bucket_hash = ?').bind(bucket),
  ]);
  if (results[2].results[0]?.request_count > limit)
    throw new RequestLimitError(429, 'Too many checks. Wait a minute and try again.', Math.max(1, Math.ceil(((window + 1) * 60_000 - now) / 1000)));
}

export async function limitRequest(
  request: Request, db: D1Database | undefined, scope: 'allowance' | 'seller', actor: string, now = Date.now(),
) {
  if (!db) throw new RequestLimitError(503, 'The checker is temporarily unavailable. Please try again.');
  const address = request.headers.get('cf-connecting-ip') || request.headers.get('x-keymeter-client-ip') || 'unknown';
  try {
    await consume(db, scope + ':address', address, scope === 'seller' ? 30 : 60, now);
    await consume(db, scope + ':credential', actor, scope === 'seller' ? 20 : 30, now);
  } catch (error) {
    if (error instanceof RequestLimitError) throw error;
    throw new RequestLimitError(503, 'The checker is temporarily unavailable. Please try again.');
  }
}

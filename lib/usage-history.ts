import { readTaskHistory } from './billing';
import type { TaskHistory } from './billing';
import { lookupAccount } from './quota';

export async function lookupUsageHistory(
  db: D1Database | undefined,
  key: string,
  secret: string | undefined,
  config: { ownerKey?: string; registered?: string } = {},
  transport: typeof fetch = fetch,
): Promise<TaskHistory> {
  const empty = (state: TaskHistory['state']): TaskHistory => ({ state, records: [], hasMore: false });
  if (!db || !secret) return empty('not_connected');
  try {
    // No seller connection means no extra provider request is needed.
    const saved = await db.prepare('SELECT id FROM billing_connection WHERE id = 1').first();
    if (!saved) return empty('not_connected');
    // Reauthenticate the complete customer key server-side. Never accept an
    // account roster, key ID, or balance supplied by a browser as authorization.
    const { identity } = await lookupAccount(key, config, transport);
    return await readTaskHistory(db, key, secret, transport, undefined, identity);
  } catch {
    return empty('unavailable');
  }
}

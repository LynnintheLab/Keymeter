import type { Allowance } from './quota';

export type HistoryEntry = {
  checkedAt: string;
  used: number;
  remaining: number | null;
  change: number | null;
};

type StoredCheck = {
  checked_at: string;
  used_micros: number;
  remaining_micros: number | null;
};

const historySize = 30;
const micros = 1_000_000;

export async function recordCheck(
  db: D1Database | undefined,
  key: string,
  allowance: Allowance,
): Promise<HistoryEntry[] | null> {
  if (!db) return null;
  try {
    const digest = await crypto.subtle.digest('SHA-256',
      new TextEncoder().encode('keymeter:quota-history:v1\0' + key));
    const keyHash = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');

    // Keep one predecessor so even the oldest visible check retains its change.
    // D1 executes the batch atomically. ID breaks ties for simultaneous checks.
    const retained = historySize + 1;
    const [, , history] = await db.batch<StoredCheck>([
      db.prepare(`INSERT INTO quota_checks (key_hash, checked_at, used_micros, remaining_micros)
        VALUES (?, ?, ?, ?)`).bind(keyHash, allowance.checkedAt, Math.round(allowance.used * micros),
          allowance.remaining === null ? null : Math.round(allowance.remaining * micros)),
      db.prepare(`DELETE FROM quota_checks WHERE id IN (
        SELECT id FROM quota_checks WHERE key_hash = ?
        ORDER BY checked_at DESC, id DESC LIMIT -1 OFFSET ?
      )`).bind(keyHash, retained),
      db.prepare(`SELECT checked_at, used_micros, remaining_micros FROM quota_checks
        WHERE key_hash = ? ORDER BY checked_at DESC, id DESC LIMIT ?`).bind(keyHash, retained),
    ]);
    const rows = history.results;
    return rows.slice(0, historySize).map((row, index) => {
      const previous = rows[index + 1];
      return {
        checkedAt: row.checked_at,
        used: row.used_micros / micros,
        remaining: row.remaining_micros === null ? null : row.remaining_micros / micros,
        change: previous ? (row.used_micros - previous.used_micros) / micros : null,
      };
    });
  } catch {
    // Storage can be temporarily unavailable even when the provider check succeeds.
    return null;
  }
}

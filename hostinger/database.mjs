import mysql from 'mysql2/promise';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { requireConfig } from './config.mjs';

const poolKey = Symbol.for('keymeter.mysql.pool');
export function getPool() {
  if (!globalThis[poolKey]) {
    const config = requireConfig();
    globalThis[poolKey] = mysql.createPool({
      host: config.DB_HOST, port: Number(config.DB_PORT || 3306),
      user: config.DB_USER, password: config.DB_PASSWORD, database: config.DB_NAME,
      connectionLimit: 5, queueLimit: 100, waitForConnections: true,
      charset: 'utf8mb4', supportBigNumbers: true, bigNumberStrings: true,
      decimalNumbers: true, multipleStatements: false, connectTimeout: 10000,
      flags: ['-FOUND_ROWS'],
      ...(config.DB_SSL === 'true' ? { ssl: { rejectUnauthorized: true } } : {}),
    });
  }
  return globalThis[poolKey];
}
export async function closeDatabase() {
  if (!globalThis[poolKey]) return;
  const previous = globalThis[poolKey];
  globalThis[poolKey] = undefined;
  await previous.end();
}
export async function transaction(operation) {
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const value = await operation(connection);
    await connection.commit();
    return value;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
}
export async function lock(connection, name) {
  await connection.execute('INSERT INTO keymeter_locks (id) VALUES (?) ON DUPLICATE KEY UPDATE id = id', [name]);
  await connection.execute('SELECT id FROM keymeter_locks WHERE id = ? FOR UPDATE', [name]);
}

export function mysqlSql(sql) {
  // MySQL requires an extra derived table when pruning the table being selected.
  const normalized = sql.replace(/\s+/g, ' ').trim();
  if (/^DELETE FROM quota_checks WHERE id IN \( SELECT id FROM quota_checks WHERE key_hash = \? ORDER BY checked_at DESC, id DESC LIMIT -1 OFFSET \? \)$/.test(normalized))
    return 'DELETE FROM quota_checks WHERE id IN (SELECT id FROM (SELECT id FROM quota_checks WHERE key_hash = ? ORDER BY checked_at DESC, id DESC LIMIT 18446744073709551615 OFFSET ?) AS old_checks)';
  return sql.replace(/INSERT OR IGNORE INTO/gi, 'INSERT IGNORE INTO')
    .replace(/ON CONFLICT\([^)]+\) DO UPDATE SET/gi, 'ON DUPLICATE KEY UPDATE')
    .replace(/excluded\.([a-z_]+)/gi, 'VALUES($1)');
}
function resultOf(value) {
  return Array.isArray(value)
    ? { success: true, results: value, meta: { changes: 0 } }
    : { success: true, results: [], meta: { changes: value.affectedRows ?? 0 } };
}
class Statement {
  constructor(sql, values = []) { this.sql = sql; this.values = values; }
  bind(...values) { return new Statement(this.sql, values); }
  async execute(connection) {
    try {
      const returningLock = /^UPDATE billing_connection SET refresh_lock_until = \? WHERE id = 1 AND encrypted_session = \? AND refresh_lock_until <= \? RETURNING id$/i.test(this.sql.replace(/\s+/g, ' ').trim());
      const query = returningLock ? this.sql.replace(/\s+RETURNING id\s*$/i, '') : this.sql;
      const [result] = await connection.execute(mysqlSql(query), this.values);
      if (returningLock) return result.affectedRows === 1 ? [{ id: 1 }] : [];
      return result;
    } catch (error) {
      throw new Error(`Database operation failed (${error?.code || 'unknown'}).`);
    }
  }
  async first(column) {
    const rows = await this.execute(getPool());
    const row = rows[0] ?? null;
    return row && column ? row[column] : row;
  }
  async all() { return resultOf(await this.execute(getPool())); }
  async run() { return resultOf(await this.execute(getPool())); }
}
export const database = {
  prepare(sql) { return new Statement(sql); },
  async batch(statements) {
    return transaction(async connection => {
      // D1 serializes writes. Preserve that ordering for short application batches.
      await lock(connection, 'application-batch');
      const results = [];
      for (const statement of statements) results.push(resultOf(await statement.execute(connection)));
      return results;
    });
  },
};

export async function migrateDatabase(directory) {
  const connection = await getPool().getConnection();
  const lockName = 'keymeter-migrate-' + createHash('sha256').update(process.env.DB_NAME).digest('hex').slice(0, 32);
  let acquired = false;
  try {
    const [locks] = await connection.execute('SELECT GET_LOCK(?, 30) AS acquired', [lockName]);
    acquired = Number(locks[0].acquired) === 1;
    if (!acquired) throw new Error('Another migration is running. Restart shortly.');
    await connection.query('CREATE TABLE IF NOT EXISTS keymeter_migrations (id VARCHAR(100) PRIMARY KEY, checksum CHAR(64) NOT NULL) ENGINE=InnoDB');
    const files = (await readdir(directory)).filter(name => /^\d{3}_[a-z_]+\.sql$/.test(name)).sort();
    for (const [id, file] of [['001_initial', 'schema.sql'], ...files.map(file => [file.slice(0, -4), file])]) {
      const sql = await readFile(new URL(file, directory), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const [applied] = await connection.execute('SELECT checksum FROM keymeter_migrations WHERE id = ?', [id]);
      if (applied.length && applied[0].checksum !== checksum) throw new Error('An applied schema was changed. Restore it before restarting.');
      if (!applied.length) {
        for (const statement of sql.split(';').map(value => value.trim()).filter(Boolean)) await connection.query(statement);
        await connection.execute('INSERT INTO keymeter_migrations (id, checksum) VALUES (?, ?)', [id, checksum]);
      }
    }
  } finally {
    try { if (acquired) await connection.execute('SELECT RELEASE_LOCK(?)', [lockName]); }
    finally { connection.release(); }
  }
}

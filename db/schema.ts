import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const quotaChecks = sqliteTable('quota_checks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  keyHash: text('key_hash').notNull(),
  checkedAt: text('checked_at').notNull(),
  usedMicros: integer('used_micros').notNull(),
  remainingMicros: integer('remaining_micros'),
}, (table) => [
  index('quota_checks_key_time_idx').on(table.keyHash, table.checkedAt, table.id),
]);

export const billingConnection = sqliteTable('billing_connection', {
  id: integer('id').primaryKey(),
  encryptedSession: text('encrypted_session').notNull(),
  updatedAt: text('updated_at').notNull(),
  refreshLockUntil: integer('refresh_lock_until').notNull().default(0),
});

export const billingEnrollment = sqliteTable('billing_enrollment', {
  keyHash: text('key_hash').primaryKey(),
  apiKeyId: text('api_key_id').notNull().unique(),
  keyMask: text('key_mask').notNull(),
});

export const requestLimits = sqliteTable('request_limits', {
  bucketHash: text('bucket_hash').primaryKey(),
  resetAt: integer('reset_at').notNull(),
  requestCount: integer('request_count').notNull().default(0),
}, table => [index('request_limits_reset_idx').on(table.resetAt)]);

export const sellerPassword = sqliteTable('seller_password', {
  id: integer('id').primaryKey(),
  ownerHash: text('owner_hash').notNull(),
  passwordHash: text('password_hash').notNull(),
  version: text('version').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const sellerSessions = sqliteTable('seller_sessions', {
  tokenHash: text('token_hash').primaryKey(),
  ownerHash: text('owner_hash').notNull(),
  passwordVersion: text('password_version').notNull(),
  expiresAt: integer('expires_at').notNull(),
}, table => [index('seller_sessions_expiry_idx').on(table.expiresAt)]);

export const appSettings = sqliteTable('app_settings', {
  id: text('id').primaryKey(),
  valueJson: text('value_json').notNull(),
  updatedAt: text('updated_at').notNull(),
});

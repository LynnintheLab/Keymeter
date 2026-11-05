import { database } from './database.mjs';

// This build-time alias is included only in the standalone Node build.
export const env = new Proxy({} as Cloudflare.Env, {
  get(_target, key) {
    if (key === 'SELLER_AUTH_MODE') return 'hostinger-gateway-v1';
    if (key === 'DB') return database;
    if (key === 'KEYMETER_OWNER_EMAIL') return process.env.ADMIN_EMAIL?.trim().toLowerCase();
    if (key === 'KEYMETER_OWNER_ID') return 'hostinger-owner';
    return process.env[String(key)];
  },
});

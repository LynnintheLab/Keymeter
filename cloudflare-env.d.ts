declare namespace Cloudflare {
  interface Env {
    RUNNINGHUB_OWNER_KEY?: string;
    REGISTERED_KEY_HASHES?: string;
    KEYMETER_OWNER_ID?: string;
    KEYMETER_OWNER_EMAIL?: string;
    BILLING_ENCRYPTION_KEY?: string;
    SELLER_AUTH_MODE?: string;
    DB?: D1Database;
    BUCKET?: R2Bucket;
  }
}

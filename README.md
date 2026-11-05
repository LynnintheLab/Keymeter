# Keymeter

A RunningHub Enterprise-Shared key allowance and job-charge checker, separate from the KeyLedger customer vault.

Customers enter their issued key to see its spending limit, usage, remaining allowance, and recent individual job charges. The shared account wallet is never substituted for a key's allowance. A connected seller account makes its current and future shared keys available automatically; there is no individual key-enabling step.

The seller connection is encrypted in persistent storage. An optional RunningHub refresh token enables renewal when supported by the provider. Visiting or redeploying the app does not clear the connection. Revoked provider credentials can still require reconnection.

## Hostinger

Follow [HOSTINGER.md](HOSTINGER.md) for the complete deployment guide and environment variables. Use a dedicated MySQL database, Node 24.x, framework **Other**, build command `npm run build:hostinger`, output `dist`, and entry `server.mjs`.

```sh
npm ci --include=dev
npm run hostinger:secrets
npm run build:hostinger
npm run start:hostinger
```

Keep the generated secrets and database password private in hPanel. The `.env.example` file contains placeholders only. Standalone owner sign-in is at `/login`, and connection setup is at `/seller`. Set `ADMIN_EMAIL` to your fixed owner email and configure Resend privately before first setup. Verify the emailed setup code at `/login`; the website generates a 64-character owner key and shows it once. Save it privately. Later sign-ins use that key plus an emailed code. **Forgot key** verifies your current email and replaces the key, revoking old keys and sessions while preserving RunningHub. Owner email can be changed at `/owner/email` using the current key and verification of both addresses. `ADMIN_PASSWORD_HASH` is an optional legacy fallback and stays blank for fresh installs. A new Hostinger database needs its initial RunningHub connection; it does not automatically inherit the existing Sites database.

## Local preview with email sign-in

After `npm run build:hostinger`, run `npm run preview:hostinger` with MariaDB installed. This serves the actual standalone build on `http://127.0.0.1:5175`, including `/login`, rather than the Sites-specific owner screen from `npm run dev`. It uses a separate private database and generated server secrets under `.sites-runtime/hostinger-preview/`. Its `owner-access.txt` contains setup notes only. Privately set the fixed `ADMIN_EMAIL`, `RESEND_API_KEY`, and `AUTH_EMAIL_FROM` in that folder's `config.json`, then restart the preview. First setup verifies that email before issuing the owner key once in the browser. Existing settings and local data are preserved; the launcher does not reset your account or RunningHub connection. No test code or authentication bypass is available. Stop the existing preview before starting this one.

## Validation

```sh
node --experimental-transform-types --test tests/*.test.mjs
npm run test:hostinger
npx tsc --noEmit
```

Tests use synthetic credentials. MySQL integration checks require a disposable local database. Compare a real key's job charges with RunningHub's console before sharing the customer URL. See [SECURITY-REVIEW.md](SECURITY-REVIEW.md) for the review scope, evidence, and remaining limits.

## Sites

The original Sites deployment remains supported with `npm run build`. Its access policy, verified ChatGPT identity, D1 storage, and runtime secrets are managed by Sites. Preserve `.openai/hosting.json`, applied migrations, and the database's encryption key when updating that deployment. Do not publish local environment files, runtime state, or credentials.

## Top-up pricing

Customers see current packages directly on the checker page. “Top up my key” at the bottom of the pricing card opens the seller's Facebook/Telegram contact dialog. The owner edits the six Ks prices in `/seller` → API pricing. Prices are stored in the database, rendered on page load, and refreshed when returning to the checker. No API key is sent to the contact links. Customer accounts, direct top-up orders, payments, and seller notifications are deferred.

## Product details

- [Checker behavior and provider limitations](CHECKER.md)
- [Full website brief](KEYMETER-PROMPT.md)
- [Hostinger deployment](HOSTINGER.md)
- [Security review](SECURITY-REVIEW.md)

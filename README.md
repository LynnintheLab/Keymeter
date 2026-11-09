# Keymeter

Keymeter is a customer-facing balance and billing checker for RunningHub Enterprise-Shared API keys. Customers enter their issued key to see how much they can still spend, what changed since the last check, and what RunningHub charged for recent jobs. The seller manages the billing connection and advertised top-up prices from a protected dashboard.

## Customer checker

1. Open the checker and enter the full RunningHub Enterprise-Shared key.
2. Click **Check balance** to see the key’s spending limit, amount used, and remaining allowance in USD. Keymeter reads the individual key allowance from RunningHub. The shared account wallet has its own balance.
3. Open **Balance checks** for up to 30 saved readings for that key. Each reading includes the time it was checked. Changes are calculated from successive usage totals.
4. View **Usage history** for up to 50 recent jobs from the last 30 days when seller billing is available and the key can be matched safely. Each row shows the charge RunningHub reports for that job.
5. Select **Top up my key** under the USD packages and Ks prices to contact the seller on Facebook or Telegram. The seller handles purchases through those channels.

The checker is responsive on mobile and desktop. Keymeter uses the submitted key for the read-only lookup and stores a one-way fingerprint with its balance history.

## Seller dashboard

- Connect the RunningHub account that issued the shared keys. Its current and future Enterprise-Shared keys can be matched automatically when a customer checks their key.
- Review connection status, replace the connection, or add an optional RunningHub refresh token to an existing connection. The encrypted connection persists across visits and redeployments that use the same database and encryption key. If RunningHub revokes the saved credentials or they can no longer be renewed, reconnect from the dashboard.
- Edit the six top-up prices under **API pricing**. Saved prices appear on the customer checker. The contact dialog sends customers to Facebook or Telegram without including their API key.

On standalone hosting, open `/login` and verify the code sent to the configured owner email. First setup issues a 64-character owner key that is shown once. Save it privately. Future sign-ins use that key and a fresh email code. **Forgot key** uses email verification to issue a replacement. The protected email settings at `/owner/email` verify both addresses before changing the owner email. Open `/seller` after signing in.

## Architecture

| Area | Implementation |
| --- | --- |
| Web app | TypeScript and React using Next.js App Router conventions, built with Vinext and Vite |
| Customer lookup | Server-side, read-only RunningHub API calls that return data for the matching key |
| Billing | Server-side seller session with encrypted storage and optional token renewal |
| Standalone hosting | Node.js gateway, MySQL persistence, and Resend for owner verification emails |
| Sites hosting | Cloudflare Workers and D1, with verified Sites owner identity and a separate billing password |

`app/` contains the checker, seller dashboard, and API routes. `lib/` contains allowance, billing, history, and pricing logic. `hostinger/` contains the standalone gateway, MySQL migrations, and owner authentication. `worker/`, `db/`, and `drizzle/` support the Sites runtime and its data layer.

## Run locally

Use Node.js 24 and npm.

```sh
npm ci --include=dev
npm run dev
```

To exercise the standalone owner sign-in flow, install MariaDB, then run the standalone preview.

```sh
npm run build:hostinger
npm run preview:hostinger
```

The standalone preview serves `http://127.0.0.1:5175` by default and keeps a separate local database. Follow the [Hostinger guide](HOSTINGER.md) to configure the owner email and Resend sender privately before requesting a verification code.

## Deploy to Hostinger

Use Hostinger’s **Node.js Web App** flow with a dedicated MySQL database.

| Setting | Value |
| --- | --- |
| Framework preset | Other |
| Node version | 24.x |
| Package manager | npm |
| Root directory | `./` |
| Build command | `npm run build:hostinger` |
| Output directory | `dist` |
| Entry file | `server.mjs` |
| Start command, if shown | `npm run start:hostinger` |

Use [`.env.example`](.env.example) as the configuration reference. Set the HTTPS origin, database credentials, owner email, Resend settings, session secret, and billing encryption key in hPanel. Run `npm run hostinger:secrets` to generate secrets for a fresh standalone deployment. Keep the same `BILLING_ENCRYPTION_KEY` when reusing a database with an existing billing connection. A new MySQL database needs its own initial RunningHub connection.

After deployment, verify that the home page and `/login` load, confirm that the setup code arrives, and compare a real key’s allowance and job rows with the RunningHub console. If Hostinger reports a completed build but the site returns HTTP 503, inspect the runtime logs and confirm that the active release contains `server.mjs` and `hostinger-build.json` in the built output. The deployment guide covers the full setup. [Hostinger deployment guide](HOSTINGER.md)

For a Sites deployment, use `npm run build`. Sites manages access policy, owner identity, D1 storage, and runtime secrets. Keep the existing deployment’s project configuration, applied migrations, and encryption key when updating it.

## Validation and references

```sh
node --experimental-transform-types --test tests/*.test.mjs
npm run test:hostinger
npx tsc --noEmit
```

Automated checks use synthetic credentials. MySQL integration checks require a disposable database. Live job history depends on the seller connection and RunningHub’s billing endpoints, which can change.

- [Checker behavior and RunningHub limitations](CHECKER.md)
- [Product and interface details](PRODUCT.md)
- [Full website brief](KEYMETER-PROMPT.md)
- [Security review and known limits](SECURITY-REVIEW.md)

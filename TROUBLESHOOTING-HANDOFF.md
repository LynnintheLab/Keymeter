# Keymeter full: RunningHub timeout handoff

Prepared 2026-11-13. This report covers the full Keymeter application, not Keymeter Lite or APILedger. No credentials are included.

## Repository and live site

- Repository: https://github.com/LynnintheLab/Keymeter
- Branch: `main`
- Application release under investigation: `b1de3db` (remembered owner login and server diagnostics).
- Previous balance/history separation release: `00fa939`.
- Public checker: https://keymeter.lynninthelab.space/
- Owner panel: https://keymeter.lynninthelab.space/seller
- Owner login: https://keymeter.lynninthelab.space/login

If repository access is private, authorize the other development tool to access it. There is no need to publish secrets or change repository visibility.

## Current failure

The website loads, the pricing/advertisement render, and the authenticated seller panel opens. The current incident is an outbound provider connection failure, not the earlier startup/HTTP 503 incident that prevented the whole website from loading.

The public checker displays:

> This server could not reach RunningHub. Seller sign-in is not required for balance checks. Please try again shortly.

The owner panel can show:

> Connection saved · RunningHub temporarily unavailable

The encrypted connection is still saved. A future token expiry or an enabled refresh token does not demonstrate that the hosting server can reach the provider. The current results do not establish whether a supplied real key or token would be accepted after connectivity is restored.

## Evidence from the actual Hostinger server

The owner ran the new Connection test. Their screenshot shows a check at **2026-11-13 14:06:59**, as displayed in their browser's local time:

| Probe | Result | Duration |
| --- | --- | --- |
| DNS IPv4 | UI says Completed | 0.01 s |
| DNS IPv6 | UI says Completed | 0.01 s |
| Balance API, Node fetch | TimeoutError | 10.00 s |
| Balance API, native HTTPS | ETIMEDOUT · Error | 10.00 s |
| Billing API, Node fetch | TimeoutError | 10.00 s |
| Billing API, native HTTPS | ETIMEDOUT · Error | 10.00 s |

These were **anonymous probes**, without an API key or seller token. They did not receive a reported HTTP response before the deadline. This rules out a bad customer credential as the explanation for these particular diagnostic timeouts.

The DNS UI does not show the resolved address values. "Completed" alone is not proof that DNS returned correct or reachable addresses; inspect the raw diagnostic or CLI output before concluding DNS is healthy. The UI's Copy report projection currently omits address values; the CLI includes them.

Equivalent anonymous probes from the developer's local network previously reached RunningHub in roughly 0.26–0.38 seconds and received expected missing-credential business responses. This comparison supports a Hostinger-specific route, filtering, DNS, or network configuration issue. It does **not** establish which network operator or component is responsible, nor whether TCP connection or TLS negotiation is the failing phase.

## Provider requests

Customer per-key quota lookup:

```text
GET https://www.runninghub.ai/openapi/v2/api-key/list
Authorization: Bearer <customer's complete issued API key>
Accept: application/json
```

The application selects exactly one matching key and calculates:

```text
remaining = max(0, quotaLimit - quotaUsed)
```

It must never display the seller account's global wallet balance as a customer's remaining allowance. A null/unlimited quota is represented separately.

Seller roster probe:

```text
POST https://www.runninghub.ai/api/key/queryAllV2
Content-Type: application/json
Body: {}
```

The actual seller integration additionally uses owner-session authentication and provider billing/account endpoints implemented in `lib/billing.ts`. Its stored access/refresh tokens are AES-GCM encrypted in MySQL.

Both diagnostics and application requests use ten-second deadlines. Redirects must not forward credentials to another destination. An expected anonymous HTTP 200 response with `HEADER_API_KEY_NOT_FOUND` or `TOKEN_MISSION` demonstrates reachability only; it does not validate a real key or session.

## Hosting and build

| Setting | Value |
| --- | --- |
| Platform | Hostinger managed Node.js application |
| Framework preset | Other |
| Branch | main |
| Node | 24.x |
| Package manager | npm |
| Root directory | ./ |
| Build command | npm run build:hostinger |
| Output directory | dist |
| Entry file | server.mjs |
| Database | Hostinger MySQL, mysql2 adapter |
| Frontend/server framework | TypeScript, React, vinext with Vite and Next.js-style app routes |

The entry supports Hostinger/LiteSpeed's loader and serves the owner-authentication gateway and renderer on one listener. It uses the platform-provided PORT; do not hardcode a public port to diagnose an outbound timeout.

Environment variable names and placeholder values are in `.env.example`. Actual values are private in hPanel or ignored local configuration. Preserve the existing `SESSION_SECRET` and `BILLING_ENCRYPTION_KEY` while investigating, and do not replace the production database with a test database.

## Where to inspect the source

| File | Responsibility |
| --- | --- |
| `lib/quota.ts` | Direct API-key authentication, quota request, safe per-key projection and timeout error |
| `lib/billing.ts` | Seller session, roster/account verification, refresh and job charges |
| `lib/usage-history.ts` | Separate authorized job-history lookup |
| `app/api/allowance/route.ts` | Public balance API |
| `app/api/usage-history/route.ts` | Separate public job-history API |
| `app/api/seller/billing/route.ts` | Owner billing connection API |
| `app/checker.tsx` | Checker, gauge, independent balance/history requests |
| `app/seller/billing-setup.tsx` | Seller connection screen |
| `app/seller/connection-diagnostics.tsx` | Diagnostic display and Copy report |
| `hostinger/diagnose-runninghub.mjs` | Anonymous DNS/fetch/native-HTTPS probes and CLI |
| `hostinger/provider-health.mjs` | Runs the fixed probe batch |
| `hostinger/gateway.mjs` | Owner authentication, same-origin diagnostic route and rate limit |
| `hostinger/security.mjs` | Hashed owner sessions and remembered browser renewal |
| `hostinger/runtime.ts` | Hostinger runtime/environment and database adapter |
| `hostinger/database.mjs` | MySQL access and migrations |
| `hostinger/prepare.mjs` | Copies production entry and Hostinger support files into dist |
| `server.mjs` | Production startup and gateway/renderer listener |
| `vite.config.ts` | Hostinger versus Sites build configuration |
| `HOSTINGER.md` | Deployment instructions and timeout diagnosis |
| `SECURITY-REVIEW.md` | Implemented security controls and verification limits |

## Checks already completed

- Customer balance is independent of the saved seller session; missing or broken billing must not prevent a successful direct balance lookup.
- Balance and job-history requests are separate; failure to load history must not erase balance.
- No global-wallet substitution, sample balances, or authorization based only on a key suffix.
- Browser-direct fallback was tested previously and failed in Chromium because of duplicate CORS origin headers from RunningHub. Do not assume a browser request can replace the backend route.
- No supported alternate international hostname has been established for this incident. Do not send these credentials to a China-region domain, an arbitrary proxy, or a guessed API host.
- At release b1de3db: TypeScript, focused ESLint, Hostinger production build, all 43 application tests and all 13 Hostinger tests passed. Hostinger tests include a disposable MariaDB instance and compiled Node/LiteSpeed entry checks. These do not prove connectivity from the production Hostinger network.
- Remembered owner login is enabled by default for 90 days with at-most-daily renewal. Old short sessions need one fresh remembered login. This change does not repair provider connectivity.
- The assistant could not access hPanel because local browser access was disabled. No on-server shell inspection, firewall change, destination allowlisting, or verified network repair has been performed.

## Safe next investigation

1. Inspect the actual Hostinger server's resolved IPv4/IPv6 addresses, TCP/443 connectivity, TLS handshake and outbound HTTPS policies for `www.runninghub.ai`. Compare against a known reachable HTTPS destination. Do not infer the failing layer from the ten-second deadline alone.
2. Run the included no-credential report from the deployed Node directory:

   ```sh
   node hostinger/diagnose-runninghub.mjs
   ```

   From a source checkout whose running build is in dist, use `node dist/hostinger/diagnose-runninghub.mjs` instead.
3. A second anonymous check from Hostinger's terminal can compare IPv4 routing:

   ```sh
   curl -4 --connect-timeout 5 --max-time 12 --verbose 'https://www.runninghub.ai/openapi/v2/api-key/list'
   ```

   This command contains no credential. A provider missing-key response is expected if the route works. Do not put real tokens into shell history or paste them into support logs.
4. Ask Hostinger support to check the server's outbound route to `www.runninghub.ai:443`, its egress/source IP, and possible destination-side filtering. Give them the anonymous report and timestamp above. Ask them to distinguish DNS, TCP, TLS, IPv4/IPv6, and remote blocking.
5. If Hostinger cannot repair the route, evaluate a private, authenticated relay in another server environment or moving the backend. Verify that environment reaches the provider before designing or deploying a relay; retain key isolation, fixed destinations, TLS verification, limits and credential secrecy.
6. After connectivity works, verify a current real key's allowance and seller per-job charges separately against RunningHub. A missing/expired session may then need its own authentication diagnosis.

## Suggested prompt for the next AI

```text
Help fix the full Keymeter application at https://github.com/LynnintheLab/Keymeter on main.
Read TROUBLESHOOTING-HANDOFF.md, HOSTINGER.md and SECURITY-REVIEW.md first.

The live UI works at https://keymeter.lynninthelab.space, but all anonymous balance and billing
HTTPS probes from Hostinger time out at 10 seconds with both Node fetch and native HTTPS.
Equivalent probes work from another network. DNS UI says Completed but does not show addresses.

Diagnose the real Hostinger outbound route before changing credentials or application logic.
The customer balance must work with its API key alone, independently of seller login.
Preserve the existing UI, remembered owner login, encrypted seller connection, database and secrets.
Never replace a per-key allowance with the global wallet or sample data. Do not send keys through
a public proxy. If proposing another host/relay, verify official endpoint compatibility and actual
reachability first. Explain what is proven, what is still a hypothesis, and validate the final fix
on the actual hosting environment with a current key.
```

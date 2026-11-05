# Keymeter: per-key allowance

This is separate from the KeyLedger customer vault. It does not import those customer records, store credentials, or call a model. New Sites are owner-private for testing. When ready, review Site sharing and grant the intended customers access; sharing the URL alone does not grant access.

## How to check

Enter a full international RunningHub Enterprise-Shared key **on the checker, not in chat**. Check allowance makes one read-only GET to https://www.runninghub.ai/openapi/v2/api-key/list from the server. Only the unique matching key’s limit, usage, remaining amount, quota/expiry state, last four characters and lookup time, recorded balance checks, and its job usage are returned. Only real results are shown after a successful check. During a lookup or after an error, the statement shows no figure. Reloading does not remember a key. The app never queries the shared wallet or calls a job. A key's quota is not a guarantee that the common wallet can fund a job.

## Automatic job usage

Connecting the seller account makes its current and future Enterprise-Shared keys available automatically. Customers present a valid full key. The server authenticates it with RunningHub, then compares its complete account key roster, masked identities and immutable creation timestamps with the seller account before selecting a billing key ID. Missing, changed or ambiguous rosters fail closed. The recent job table shows up to 50 model/workflow runs from the past 30 days and each reported charge in its reported currency. Parent/child amounts are not summed.

The seller connection is encrypted in D1 using the stable runtime BILLING_ENCRYPTION_KEY. Setup access requires the verified Site owner identity through KEYMETER_OWNER_EMAIL or KEYMETER_OWNER_ID plus a separately chosen billing password. The owner sets it privately on /seller once. Password unlock lasts eight hours; Lock billing removes only that unlock session and keeps RunningHub connected. Keep the same encryption key across redeployments and database backups. Visiting the site does not require reconnecting.

An optional RunningHub Rh-Refreshtoken enables automatic renewal near expiry and one retry after an expired-access response. A connected owner can add just the refresh token once; the saved access token does not need re-entry. The replacement is provider-authenticated and checked against the saved account before encrypted storage. Access and rotating refresh tokens are stored encrypted. A database compare-and-swap lock prevents simultaneous refreshes from overwriting a manual reconnection or disconnect. Transient provider outages preserve the stored connection. If RunningHub revokes both credentials, the seller must reconnect.

The integration uses RunningHub website query routes and can need maintenance when those routes change. Compare a customer's real job rows against the official console before public customer access. This version verifies the seller session and real response schemas. The customer key used for live validation had no recorded jobs in the query window.

## Request protection

Customer checks and owner setup have atomic per-minute limits using hashed key/owner and network identifiers. Raw keys, session tokens and IP addresses are excluded from the limiter database. A failed limiter database check returns a temporary service error before an upstream request. Responses containing balances, jobs and setup state use private no-store headers.

## Balance checks

A successful check saves a dated reading of usage and remaining allowance. The table shows up to 30 checks for the submitted key, newest first. The first reading establishes the starting point. Each later change is the difference between two reported usage totals. A decrease can occur when the provider revises or resets a counter. Reading times indicate when someone checked the key.

The server stores a one-way fingerprint of the full key with the readings. A new key starts its own history. Only a successful lookup with the same full key can read its readings. If history storage is unavailable, the verified current allowance can still be shown.

For older job-level records, sign in to the seller account and select the key in [RunningHub Tasks & Billing](https://www.runninghub.ai/call-api/bill-task?tab=detail).

## Provider limits

RunningHub documents the list route and fields quotaLimit / quotaUsed in its [API reference](https://www.runninghub.cn/runninghub-api-doc-cn/api-432924538); the reference is marked in development and shows the Chinese host. This checker targets the international .ai host and USD console. Do not submit keys for a different regional account here. [Account status](https://www.runninghub.cn/runninghub-api-doc-en/api-425761030) describes the wallet, not this figure. The full key authenticates the upstream request; the server never returns the raw list, provider error messages or customer names. Ambiguous masked matches, missing fields and upstream denial fail closed. The app does not log or persist the submitted key. Limited remaining = max(0, cap − used); when the cap is null no numeric limit or remaining balance is claimed. The API’s undocumented numeric status is not treated as proof a job can run.

## Optional seller-assisted access

If a customer's key cannot read the list itself but an owner credential is permitted to read the list, configure both secret runtime variables on this Site: RUNNINGHUB_OWNER_KEY (authorized owner credential) and REGISTERED_KEY_HASHES (comma-separated lowercase SHA-256 hashes of the exact sold keys, never masked keys). Otherwise leave both unset. For an enrolled key only, the server uses the owner credential and filters the response to that key. Enrollment is a read-only grant: remove its hash when a key is rotated or access should end. Do not make the owner key public, store it in code, or paste it into the customer form. This feature does not grant new permissions at RunningHub.

Generate each fingerprint locally on a Mac (zsh); the key is typed at a hidden prompt, not passed as a command argument:

```zsh
read -rs 'meter_input?Sold key (hidden): '
builtin printf %s "$meter_input" | shasum -a 256
unset meter_input
```

## Checks

Use Node 24+, then `node --experimental-transform-types --test tests/*.test.mjs` and `npx tsc --noEmit`. Tests use synthetic keys and mocked provider replies, including an actual workerd request that must reach the fixed endpoint and must not follow redirects. For final validation, compare one authorized real lookup with the matching RunningHub console row.


## Top-up popup and pricing

The checker page displays all six USD packages and their Ks prices. “Top up my key” at the bottom opens a separate contact-only popup with the seller's Facebook/Telegram links. It does not send a message or top up a key automatically. Prices are editable only through the protected API pricing section in billing settings. Public pricing returns only the six validated packages and the last update time; it does not disclose owner details or submitted keys. Storage failures show an availability message and contact buttons.

On standalone Hostinger, `/login` uses an owner key and email codes rather than ChatGPT. Fresh setup verifies the privately pinned `ADMIN_EMAIL` and generates a 64-character owner key displayed once; only its salted hash is stored. Later login requires the key and an email code. Forgot key verifies the current email and issues a replacement once, revoking the old key and sessions while preserving the saved RunningHub connection. `/owner/email` requires the current owner key plus verification of the old and new addresses, invalidating old sessions after a completed change. Email delivery requires privately configured Resend credentials and a verified sender. `ADMIN_PASSWORD_HASH` is an optional legacy fallback; fresh installs leave it blank.

Uncharged RunningHub jobs can omit their row currency. Those rows use the verified billing-response currency; malformed nonempty currencies and rows attributed to other keys still fail validation. Missing charges remain unknown, and explicitly reported zero charges remain zero.

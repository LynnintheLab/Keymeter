# Project notes

Updated: 2026-11-13

## Current status

Balance lookup now runs independently of the saved seller billing session. The customer UI requests the balance first, then loads job history separately. A missing, corrupt or unavailable seller session cannot delay or clear a successful balance. The existing gauge, Digimium advertisement, pricing and contact popup are preserved.

The deployed Hostinger site was observed timing out when contacting RunningHub after about ten seconds. The official endpoint answered from the local network. This update does not establish that Hostinger's outbound connection is repaired. Browser access to hPanel still reported disabled during verification.

## Last thing done

- Added a balance-only response path and a separate, rate-limited job-history endpoint that reauthenticates the full key server-side.
- Added request cancellation and sequence guards so late history responses cannot appear under a different key.
- Try the customer's API key before any optional, explicitly enrolled operator fallback. A stale operator credential cannot block a successful direct lookup.
- Added credential-free Hostinger DNS, fetch and native HTTPS diagnostics and safe runtime error labels. Kept the saved tokens and encryption settings unchanged.
- Recognize RunningHub's specific missing/invalid seller-token business errors without treating every forbidden response as an expired session.
- Verified TypeScript, the Hostinger production build, all 43 application tests and all 12 Hostinger tests. New tests cover disconnected/broken billing, successful separate history, forged browser metadata and colliding key masks. Browser UI testing remains unavailable while local browser access is disabled.

## Next steps

- Redeploy the latest `main` commit on Hostinger if automatic deployment is disabled. Inspect runtime logs for `[Keymeter provider network]`.
- In the deployed Node directory run `node hostinger/diagnose-runninghub.mjs` (or `node dist/hostinger/diagnose-runninghub.mjs` from the source root). Compare transports and resolve the Hostinger outbound connection issue before claiming live balance lookup is restored. See `HOSTINGER.md`.
- Complete live browser verification with a current customer key after outbound access works. Do not change encryption secrets or repeatedly replace saved seller tokens to troubleshoot network timeouts.
- To try a video banner, use `DIGIMIUM-MOTION-PROMPT.md` with the assets in `public/digimium/`. Review the generated loop before replacing the CSS scene.

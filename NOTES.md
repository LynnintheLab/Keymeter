# Project notes

Updated: 2026-11-13

## Current status

Hostinger owner login now remembers a verified browser by default for 90 days and renews its database expiry at most daily during use. Returning to the admin panel skips the key and email code while that session remains valid. Setup, recovery, and verified email changes also remember the newly verified browser. Existing short sessions keep their old expiry and need one fresh remembered login. Opting out retains the eight-hour session. Sign-out, expiry, recovery, account changes, or cookie removal still revoke or remove access.

Balance lookup remains independent of the saved seller billing session. The customer UI requests balance first and job history separately. The speedometer, Digimium advertisement, pricing, and contact popup are preserved.

The public Hostinger site was observed timing out on RunningHub calls after about ten seconds while anonymous local probes answered. That outbound route is not proven repaired. The seller panel now offers an owner-only Connection test that runs fixed anonymous DNS, Node fetch, and native HTTPS probes on the actual server and copies a safe report. Local browser access still reported disabled, so live admin browser verification could not be completed.

## Last thing done

- Made Keep me signed in selected by default and added guarded, daily renewal for remembered sessions. Passwords and email codes are not saved in the browser.
- Used an HttpOnly, Secure-on-HTTPS, SameSite=Lax session cookie so top-level links from email retain login. Signed form proofs and strict same-origin checks remain required for owner mutations.
- Added migration 005 for remembered sessions without modifying previously applied schema checksums. The migration is included automatically in Hostinger build output.
- Preserved the renewed cookie through gateway pages, redirects, and compiled application responses. Logout and new verified sessions override the old cookie.
- Added an owner-only, inputless, same-origin connection diagnostic with a 30-second cooldown and a responsive report/copy interface. It sends no customer keys or seller tokens and changes no saved connection.
- Passed TypeScript, focused ESLint, the Hostinger production build, all 43 application tests, and all 13 Hostinger tests, including disposable MariaDB, restart persistence, daily renewal, expiry/revocation, CSRF, diagnostic authorization, and the compiled server.
- Application regression command: `node --experimental-transform-types --test tests/*.test.mjs` under Node 24. Hostinger checks: `npm run test:hostinger` after `npm run build:hostinger`.

## Next steps

- Redeploy the latest main commit on Hostinger if automatic deployment is disabled. No new environment variables are needed; preserve SESSION_SECRET and BILLING_ENCRYPTION_KEY.
- Sign in once with Keep me signed in checked. Reopen /seller to confirm that browser keeps access without another OTP.
- In /seller use Connection test, then Copy report. Resolve the Hostinger outbound HTTPS issue using that result before claiming real balance lookup is restored. The terminal alternative is `node hostinger/diagnose-runninghub.mjs` from the deployed Node directory; see HOSTINGER.md.
- Complete live browser verification with a current customer key after outbound access works. Do not repeatedly replace seller tokens or rotate encryption secrets to troubleshoot network timeouts.
- To try a video banner, use DIGIMIUM-MOTION-PROMPT.md and the assets in public/digimium/. Review the generated loop before replacing the CSS scene.

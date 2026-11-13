# Project notes

Updated: 2026-11-13

## Current status

The approved four-slide Digimium advertisement is now integrated into the customer's Check balance flow. A real lookup starts immediately in the background, and the visible **Skip ad** button closes the advertisement immediately. The popup uses the store's white/blue theme and the owner's revised Burmese copy; the existing sidebar ad and API packages remain in place.

Resolved. The outage was an outbound network fault, not a credential, token, database or application-logic problem.

RunningHub is served by Tencent EdgeOne, whose DNS answers differently depending on who asks. Measured on the Hostinger server on 2026-11-13: the address its resolver returns, 43.174.196.235, silently drops every packet (TCP 443 `ETIMEDOUT` at 6 s), while the sibling node 43.174.197.235, serving the same hostname, opens port 443 in 0.03 s and completes a verified TLSv1.3 handshake in 0.05 s. Outbound HTTPS was never blocked: the provider apex answered in 0.77 s, `api.resend.com` in 0.29 s and a network trace in 0.03 s, reporting egress 2a02:4780:6:1859:0:3a3f:5f0a:1 at CGK. There is no AAAA record for the provider, so IPv6 was never involved.

`hostinger/provider-fetch.mjs` now routes that one origin across its reachable edge nodes, installed by `server.mjs` at startup. The hostname is never replaced, so SNI, the Host header and certificate verification are unchanged; a node that cannot present a valid certificate for `www.runninghub.ai` is refused before any credential is sent. Only connection failures move to another address, so no request already written to a socket is replayed and no job charge can be duplicated. Redirects are still not followed.

Verified on the live deployment: an anonymous balance request with a throwaway key went from HTTP 503 after 10.34 s to HTTP 401, meaning RunningHub received and answered it. The owner confirmed a real customer key returns its allowance in the live checker. Steady-state timings over six consecutive requests were 0.34-1.02 s, against 0.45-1.17 s for the home page, which makes no provider call at all, so the provider round trip now costs effectively nothing. Balance lookup still authenticates with the customer's own key alone; no account wallet or sample balance is substituted.

One cold measurement is unresolved. The first request after a redeploy was 4.49 s, where the 2.5 s connect deadline predicts about 2.9 s. It could not be attributed, because the deployed commit at that instant was not confirmed, the server shows roughly a second of baseline variance, and the host may run more than one worker process, each with its own memory. It is a once-per-process cost on a path that then settles below a second, so it was not chased further. If first-request latency ever matters, measure it with a deployment marker that identifies the running commit.

The Connection test deliberately measures the unassisted route, so its Balance API and Billing API rows still report the ten-second timeout while the application works. That is the signal to watch: when the `TCP 443` row for the resolved address starts connecting, RunningHub has repaired the node and this routing can be removed.

## Last thing done

- Integrated the approved ad as a native React dialog with self-hosted artwork and fonts. Skip ad, Escape and backdrop dismissal keep the ongoing balance request intact; previous/next arrows and Pause control the slideshow. The additional Close button appears on slide 2 or after a store-link click.
- Checked desktop, mobile and narrow-mobile layouts, repeated submissions, input focus after dismissal, store links, reduced-motion behavior, autoplay/pause and provider-error results. The existing 43 application tests and 25 Hostinger tests pass; TypeScript and the Hostinger build pass. Targeted lint has only the two advisory native-image warnings.
- Added `hostinger/provider-fetch.mjs`, a routed transport for `https://www.runninghub.ai/` only, installed at startup by `server.mjs`. Every other destination keeps the platform fetch.
- Gave each candidate address its own HTTPS agent. Node's shared pool keys sockets by host and port alone, so a pooled connection was being reused regardless of the pinned address, which made an early version appear to work against a blackhole address and against a host presenting the wrong certificate.
- Fixed the custom DNS lookup to answer `options.all` with an array, which Node requires when happy-eyeballs is enabled. Without it every attempt failed `ERR_INVALID_IP_ADDRESS`.
- Remembered a node that refuses to connect for fifteen minutes and ordered it last, longer than the ten-minute route memory. A live probe had shown 7.02 s when the route expired and the dead node was retried first.
- Separated DNS, TCP, TLS and HTTP in the connection test and CLI, added fixed alternate-edge checks and three credential-free controls, and documented how to read the report in HOSTINGER.md.
- Passed TypeScript, the Hostinger production build, all 43 application tests and all 25 Hostinger tests, including nine failover tests and three probe tests asserting that no key, token, socket message or response body can leak into a report. ESLint reports the same 7 pre-existing errors as before these changes.

## Next steps

- After Hostinger deploys the GitHub update, test a real key on the live website: the ad should open during lookup, Skip ad should close it immediately, and the real balance should remain available. Local browser checks used synthetic keys and intercepted responses.
- Report the failing edge address 43.174.196.235 and the egress address 2a02:4780:6:1859:0:3a3f:5f0a:1 to RunningHub. Every customer routed to that node is affected, and a fix on their side is the real resolution.
- Watch the Connection test's `TCP 443` row for 43.174.196.235. When it connects, remove the routing in `hostinger/provider-fetch.mjs` and its installation in `server.mjs`.
- If the fixed addresses in `FALLBACK_ADDRESSES` ever stop serving the hostname, the resolver's own answers still apply; update the list from a fresh `node hostinger/diagnose-runninghub.mjs` rather than guessing.
- Verify seller per-job charges and job history against RunningHub now that the route works, separately from balance.
- Preserve SESSION_SECRET and BILLING_ENCRYPTION_KEY. Do not rotate tokens or keys to troubleshoot network behaviour.

## Digimium slideshow approval preview (2026-11-13)

- Prepared five short Burmese ad slides covering apps to buy, variety, Telegram ordering, payment guidance and fair-price positioning. Verified the purchasing flow against the storefront production source; payment instructions are confirmed in Telegram, so no unsupported payment-provider logos or cheapest-price promises are used.
- Added an isolated runnable review in `previews/digimium-slideshow/`, including desktop and portrait layouts, original brand artwork, local fonts/scripts, per-slide stills and `review.jpg`.
- Static/runtime/layout/text-contrast checks passed at all five slide positions for both layouts. Reused brand artwork and the single-file deck length are reviewed authoring warnings. The browser controller is disabled; manual navigation is not claimed as browser-tested.
- The checker, Check button, authentication, billing connection, routing fix and production app behavior are unchanged by this preview. Awaiting owner approval before integrating an immediately closeable ad popup.
- Next: review the five slides and wording; after approval, connect the popup to Check while the real lookup continues in the background.

### White store-theme revision (2026-11-13)

- Current status: the isolated five-slide approval preview now matches the store's white background, dark text, blue accent and Manrope/Walone typography. Product names sit beside clean native logos; the extra logo tiles and decorative framing are removed. Photoshop and Lightroom now use Adobe SVGs without baked-in white corners.
- Last thing done: simplified all five desktop/portrait slides, refreshed the review images, and restyled the preview dialog. Added explicit slide timing so the standalone player loads its navigation correctly. Both layouts pass runtime/layout checks and 56/56 text-contrast checks each; headless Chrome verifies navigation, Close/reopen and no horizontal overflow at desktop/mobile sizes.
- Next steps: owner reviews this revised preview. Production integration remains pending approval; the live checker and Check button are unchanged.

### Four-slide copy revision (2026-11-13)

- Current status: removed the former category-only slide 2. Four slides remain; the former slides 3 and 4 are now slides 2 and 3.
- Last thing done: applied the owner's exact ordering headline and payment/plan/usage support text, aligned the Telegram illustration, renumbered the deck and adjusted its timing to 24 seconds. Refreshed desktop/portrait stills and the review overview. Both layouts pass runtime/layout checks and 45/45 text-contrast checks each; browser checks confirm all four slides, Close/reopen and no page overflow.
- Next steps: owner reviews the updated copy in the isolated preview. Integrate into the checker only after approval.

### Ad navigation controls (2026-11-13)

- Current status: the isolated popup preview has a clear “ကြော်ငြာ · Ad” label, an explicit “Next slide →” button and a persistent Digimium store link. At the owner's request, Close appears on reaching slide 2 or clicking a store link; it remains visible when going back and resets when reopening.
- Last thing done: reused the player's native navigation, subscribed to slide changes, and handled the iframe store CTA through the parent click gesture so its sandbox does not block the store tab. The destination stays fixed with no key or customer data attached. Desktop, mobile and narrow-mobile browser checks cover navigation, Close visibility, reset and store-link handling.
- Next steps: owner reviews the popup interaction before production integration. The live checker remains unchanged.

### Approved production integration (2026-11-13)

- Current status: the owner approved integration and requested a GitHub push. The customer sees **Skip ad** instead of a text “Next slide” button; it dismisses immediately, while separate arrow buttons browse the four slides.
- Last thing done: added `app/digimium-slideshow.tsx` and its scoped CSS, integrated it into `app/checker.tsx`, copied the approved clean Photoshop/Lightroom SVGs and Manrope fonts, and documented the production behavior. Each check mounts a fresh slideshow, so its slide and Close visibility reset without stale content. Native-dialog focus restoration preserves users who immediately start entering another key.
- The dialog clearly says “ကြော်ငြာ · Ad”. Close also appears after reaching slide 2 or clicking a store link. Store destinations are fixed to `https://buywith-digimium.store/`, open separately, and include no API key or customer information.
- Six-second automatic progression stops during slide interaction, hidden tabs or reduced-motion preferences; manual navigation pauses autoplay. The balance fetch and job-history fetch retain their existing behavior and do not wait for ad completion.
- Validation: production build, TypeScript, 43 application tests and 25 Hostinger tests passed. Headless Chrome checks cover 1440px, 390px and 320px viewports, Skip/Close/Escape, repeated checks, store-link unlocking, pending/success/error results, keyboard navigation, autoplay and Pause. No new lint errors; two native `<img>` advisory warnings are accepted for the small self-hosted SVG/PNG artwork.
- Next steps: verify the deployed popup with a real customer key after Hostinger finishes deployment. The isolated HyperFrames authoring preview remains available under `previews/digimium-slideshow/`; it is not the production runtime.

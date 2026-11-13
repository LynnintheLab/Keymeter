# Project notes

Updated: 2026-11-13

## Current status

Resolved. The outage was an outbound network fault, not a credential, token, database or application-logic problem.

RunningHub is served by Tencent EdgeOne, whose DNS answers differently depending on who asks. Measured on the Hostinger server on 2026-11-13: the address its resolver returns, 43.174.196.235, silently drops every packet (TCP 443 `ETIMEDOUT` at 6 s), while the sibling node 43.174.197.235, serving the same hostname, opens port 443 in 0.03 s and completes a verified TLSv1.3 handshake in 0.05 s. Outbound HTTPS was never blocked: the provider apex answered in 0.77 s, `api.resend.com` in 0.29 s and a network trace in 0.03 s, reporting egress 2a02:4780:6:1859:0:3a3f:5f0a:1 at CGK. There is no AAAA record for the provider, so IPv6 was never involved.

`hostinger/provider-fetch.mjs` now routes that one origin across its reachable edge nodes, installed by `server.mjs` at startup. The hostname is never replaced, so SNI, the Host header and certificate verification are unchanged; a node that cannot present a valid certificate for `www.runninghub.ai` is refused before any credential is sent. Only connection failures move to another address, so no request already written to a socket is replayed and no job charge can be duplicated. Redirects are still not followed.

Verified on the live deployment: an anonymous balance request with a throwaway key went from HTTP 503 after 10.34 s to HTTP 401, meaning RunningHub received and answered it. The owner confirmed a real customer key returns its allowance in the live checker. Steady-state timings over six consecutive requests were 0.34-1.02 s, against 0.45-1.17 s for the home page, which makes no provider call at all, so the provider round trip now costs effectively nothing. Balance lookup still authenticates with the customer's own key alone; no account wallet or sample balance is substituted.

One cold measurement is unresolved. The first request after a redeploy was 4.49 s, where the 2.5 s connect deadline predicts about 2.9 s. It could not be attributed, because the deployed commit at that instant was not confirmed, the server shows roughly a second of baseline variance, and the host may run more than one worker process, each with its own memory. It is a once-per-process cost on a path that then settles below a second, so it was not chased further. If first-request latency ever matters, measure it with a deployment marker that identifies the running commit.

The Connection test deliberately measures the unassisted route, so its Balance API and Billing API rows still report the ten-second timeout while the application works. That is the signal to watch: when the `TCP 443` row for the resolved address starts connecting, RunningHub has repaired the node and this routing can be removed.

## Last thing done

- Added `hostinger/provider-fetch.mjs`, a routed transport for `https://www.runninghub.ai/` only, installed at startup by `server.mjs`. Every other destination keeps the platform fetch.
- Gave each candidate address its own HTTPS agent. Node's shared pool keys sockets by host and port alone, so a pooled connection was being reused regardless of the pinned address, which made an early version appear to work against a blackhole address and against a host presenting the wrong certificate.
- Fixed the custom DNS lookup to answer `options.all` with an array, which Node requires when happy-eyeballs is enabled. Without it every attempt failed `ERR_INVALID_IP_ADDRESS`.
- Remembered a node that refuses to connect for fifteen minutes and ordered it last, longer than the ten-minute route memory. A live probe had shown 7.02 s when the route expired and the dead node was retried first.
- Separated DNS, TCP, TLS and HTTP in the connection test and CLI, added fixed alternate-edge checks and three credential-free controls, and documented how to read the report in HOSTINGER.md.
- Passed TypeScript, the Hostinger production build, all 43 application tests and all 25 Hostinger tests, including nine failover tests and three probe tests asserting that no key, token, socket message or response body can leak into a report. ESLint reports the same 7 pre-existing errors as before these changes.

## Next steps

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

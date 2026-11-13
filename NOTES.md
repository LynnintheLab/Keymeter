# Project notes

Updated: 2026-11-13

## Current status

The RunningHub outage is an outbound network problem, not a credential, token or application-logic problem. Confirmed from outside Hostinger on 2026-11-13:

- The live server still cannot reach the provider. An anonymous POST to `/api/allowance` with a non-real key returns HTTP 503 after 10.3 seconds, which is the ten-second provider deadline plus overhead.
- The destination is healthy. `https://www.runninghub.ai/openapi/v2/api-key/list` answers in about 0.22 s with HTTP 200 and `HEADER_API_KEY_NOT_FOUND` from a normal network, over valid TLS.
- `www.runninghub.ai` is fronted by Tencent EdgeOne (`www.runninghub.ai.eo.dnse0.com`). Its DNS is geo-steered: the developer network is sent to 43.174.196.235, while Hostinger's subnet 72.61.212.0/24 is sent to 43.174.197.235. Both nodes answer normally from the developer network.
- There is no AAAA record for `www.runninghub.ai`, so IPv6 is not part of the outbound path. The earlier "DNS IPv6 Completed" row was an empty-address success that the old report displayed as success; it is now shown as `No addresses returned`.
- Outbound HTTPS from Hostinger is not blocked in general: the same server reaches `api.resend.com` successfully for owner sign-in codes.

That leaves two candidates, which the new layered report separates: the provider's EdgeOne edge dropping traffic from Hostinger's egress address, or Hostinger blocking outbound traffic to Tencent's range. Rotating tokens, replacing keys or redeploying cannot repair either one.

The connection test now reports resolved addresses, raw TCP 443, TLS with the real hostname as SNI and full certificate verification, both HTTP transports, the same TCP/TLS checks against fixed alternate provider edge addresses, and three credential-free controls: the provider apex, the email API this server already reaches, and a network trace that reports the server's own egress address. Balance lookup, job history, the seller connection, the database, the UI and remembered owner login are unchanged.

## Last thing done

- Separated DNS, TCP, TLS and HTTP in the anonymous connection test and CLI, added fixed alternate-edge checks and three credential-free control destinations, and documented how to read the layered report in HOSTINGER.md.
- Proved from outside Hostinger that the destination is healthy, that the provider is behind Tencent EdgeOne with geo-steered DNS, that Hostinger and the developer network are steered to different edge nodes, and that Hostinger's outbound HTTPS works for other destinations.
- Passed TypeScript, focused ESLint, the Hostinger production build, all 43 application tests and all 13 Hostinger tests, including three new probe tests that assert no credential, endpoint, socket message or response body can leak into a report.
- Pushed as 35505f4. The live site still serves the previous build: `/_next/static/chunks/DUVwCDhR.js` returns 404 until the new commit is deployed, which is a reliable public deployment check.

## Next steps

- Deploy commit 35505f4 on Hostinger. Automatic deployment did not run. Confirm with `/_next/static/chunks/DUVwCDhR.js` returning 200.
- Run Connection test in /seller, then Copy report, or run `node hostinger/diagnose-runninghub.mjs` from the deployed Node directory. Read it with the table in HOSTINGER.md.
- If the controls answer and every RunningHub row times out, the block is destination-specific. Give RunningHub the egress address from the trace row and ask them to allow it through their EdgeOne security policy. If the controls also time out, that is a Hostinger egress question instead.
- If a fixed alternate edge address connects while the resolved one does not, pin provider requests to a reachable edge node with the real hostname as SNI and full certificate verification. Do not use a public proxy and do not send these credentials to a China-region domain.
- Only after the route works, verify one current customer key's allowance and the seller per-job charges separately. Preserve SESSION_SECRET and BILLING_ENCRYPTION_KEY throughout.

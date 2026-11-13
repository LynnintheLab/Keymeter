import { Resolver } from 'node:dns/promises';
import { isIPv4 } from 'node:net';
import { Agent, request } from 'node:https';
import { Readable } from 'node:stream';

// Captured before any patch so diagnostics always measure the unassisted route.
export const directFetch = globalThis.fetch.bind(globalThis);

const PROVIDER_ORIGIN = 'https://www.runninghub.ai';
const PROVIDER_HOST = 'www.runninghub.ai';
// RunningHub is served by Tencent EdgeOne. Measured from this host on
// 2026-11-13: the resolver's own answer 43.174.196.235 silently drops every
// packet, while the sibling node 43.174.197.235 completes TCP and TLS in under
// 40 ms. A single resolved address is therefore not a dependable route. These
// are additional addresses for the same hostname, tried only after the
// resolver's answers fail to connect. Every attempt keeps the real hostname,
// so SNI, the Host header and certificate verification are unchanged, and a
// node presenting an invalid certificate fails instead of receiving anything.
const FALLBACK_ADDRESSES = Object.freeze(['43.174.197.235', '43.174.196.235']);
// The reachable node connects in about 30 ms from this host, so a short
// deadline is generous and bounds what one unreachable candidate can cost.
const CONNECT_TIMEOUT_MS = 2_500;
const ROUTE_TTL_MS = 600_000;
const RESOLVE_TTL_MS = 60_000;
// Much longer than ROUTE_TTL_MS on purpose. A measured cold request after 53
// idle minutes still cost 5.34 s because both memories had expired and the dead
// node was reconsidered first. Held for six hours, a quiet site's first visitor
// goes straight to the reachable node. It is deprioritised rather than skipped,
// and still expires, so a repaired node is picked up again. The memory is
// per-process, so a restart also reconsiders every node once.
const FAILURE_TTL_MS = 21_600_000;
const MAX_CANDIDATES = 3;

// Node's shared agent pools keep-alive sockets by host and port only, so a
// pooled connection would be reused no matter which address was pinned. Each
// address therefore gets its own agent and its own pool.
const agents = new Map();
function agentFor(address) {
  let agent = agents.get(address);
  if (!agent) {
    if (agents.size >= 8) {
      const [oldest, retired] = agents.entries().next().value;
      agents.delete(oldest);
      retired.destroy();
    }
    const family = isIPv4(address) ? 4 : 6;
    agent = new Agent({ keepAlive: true, maxSockets: 8, timeout: CONNECT_TIMEOUT_MS,
      lookup: (_hostname, lookupOptions, callback) =>
        (lookupOptions?.all ? callback(null, [{ address, family }]) : callback(null, address, family)) });
    agents.set(address, agent);
  }
  return agent;
}

function responseHeaders(raw) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw ?? {})) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      try { headers.append(name, String(item)); } catch { /* Skip headers Node accepted but fetch rejects. */ }
    }
  }
  return headers;
}

// One HTTPS attempt against a chosen address. Redirects are never followed, so
// no credential can be replayed to another destination.
export function attemptAddress(address, url, init, signal) {
  return new Promise((resolve, reject) => {
    let connected = false, settled = false, timer, request_;
    const done = () => {
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = error => {
      if (settled) return;
      done();
      try { request_?.destroy(); } catch { /* The attempt already failed. */ }
      reject(Object.assign(error, { retryable: !connected && !signal?.aborted }));
    };
    const onAbort = () => fail(signal?.reason instanceof Error ? signal.reason : Object.assign(new Error('Aborted'), { code: 'ABORT_ERR' }));
    const headers = {};
    for (const [name, value] of new Headers(init.headers ?? undefined)) headers[name] = value;
    try {
      request_ = request(url, {
        method: init.method ?? 'GET',
        headers,
        // Pin only the address. The hostname, SNI and certificate check stay intact.
        agent: agentFor(address),
      }, response => {
        if (settled) { response.destroy(); return; }
        done();
        const status = response.statusCode ?? 502;
        resolve(new Response(status === 204 || status === 304 ? null : Readable.toWeb(response),
          { status, statusText: response.statusMessage ?? '', headers: responseHeaders(response.headers) }));
      });
    } catch (error) { fail(error instanceof Error ? error : new Error('Provider request failed')); return; }
    timer = setTimeout(() => fail(Object.assign(new Error('Provider connect timeout'), { code: 'ETIMEDOUT' })), CONNECT_TIMEOUT_MS);
    request_.on('socket', socket => socket.once('secureConnect', () => { connected = true; clearTimeout(timer); }));
    request_.once('error', error => fail(error));
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    request_.end(typeof init.body === 'string' ? init.body : undefined);
  });
}

export function createProviderFetch(originalFetch, options = {}) {
  const attempt = options.attempt ?? attemptAddress;
  const now = options.now ?? (() => Date.now());
  const resolver = options.resolver ?? new Resolver({ timeout: 2_000, tries: 1 });
  let route = { address: '', expires: 0 };
  let resolved = { addresses: [], expires: 0 };
  const failures = new Map();

  async function resolveAddresses() {
    if (now() < resolved.expires) return resolved.addresses;
    let addresses = [];
    try { addresses = (await resolver.resolve4(PROVIDER_HOST)).filter(value => isIPv4(value)); }
    catch { addresses = []; }
    resolved = { addresses, expires: now() + RESOLVE_TTL_MS };
    return addresses;
  }

  async function candidates() {
    const remembered = route.address && now() < route.expires ? [route.address] : [];
    const ordered = [...new Set([...remembered, ...await resolveAddresses(), ...FALLBACK_ADDRESSES])];
    // Without this, the resolver's answer is retried first every time the
    // remembered route expires, and that request pays the full connect timeout.
    const failing = address => (failures.get(address) ?? 0) > now();
    return [...ordered.filter(address => !failing(address)), ...ordered.filter(failing)].slice(0, MAX_CANDIDATES);
  }

  return async function providerFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : undefined;
    // Only the fixed provider origin is routed. A non-string body keeps the
    // platform implementation so streaming and form bodies behave normally.
    if (!url || !url.startsWith(PROVIDER_ORIGIN + '/') || (init.body != null && typeof init.body !== 'string'))
      return originalFetch(input, init);
    const signal = init.signal ?? undefined;
    let failure;
    for (const address of await candidates()) {
      if (signal?.aborted) break;
      try {
        const response = await attempt(address, url, init, signal);
        route = { address, expires: now() + ROUTE_TTL_MS };
        failures.delete(address);
        return response;
      } catch (error) {
        failure = error;
        if (route.address === address) route = { address: '', expires: 0 };
        if (error?.retryable) failures.set(address, now() + FAILURE_TTL_MS);
        else break;
      }
    }
    throw failure ?? Object.assign(new Error('No provider route available'), { code: 'ENETUNREACH' });
  };
}

// Routes only this one origin. Every other destination keeps the platform fetch.
export function installProviderFetch(scope = globalThis) {
  if (scope.__keymeterProviderRouting) return scope.fetch;
  const routed = createProviderFetch(scope.fetch.bind(scope));
  Object.defineProperty(scope, '__keymeterProviderRouting', { value: true });
  scope.fetch = routed;
  return routed;
}

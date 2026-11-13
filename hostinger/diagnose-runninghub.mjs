import { Resolver } from 'node:dns/promises';
import { isIP, Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { request } from 'node:https';
import { pathToFileURL } from 'node:url';
import { directFetch } from './provider-fetch.mjs';

const TIMEOUT_MS = 10_000;
const REACH_TIMEOUT_MS = 6_000;
const PROVIDER_HOST = 'www.runninghub.ai';
// Fixed EdgeOne addresses observed for PROVIDER_HOST from other networks. They are
// probed with the real hostname as SNI and full certificate verification, so they
// only reveal whether this server can reach any provider edge node at all.
const ALTERNATE_ADDRESSES = Object.freeze(['43.174.196.235', '43.174.197.235']);
// Credential-free reachability controls. Nothing here carries an API key, seller
// token or request body, and no caller may add or change a destination.
const controls = Object.freeze({
  apex: Object.freeze({ url: 'https://runninghub.ai/', reads: false }),
  mail: Object.freeze({ url: 'https://api.resend.com/domains', reads: false }),
  trace: Object.freeze({ url: 'https://www.cloudflare.com/cdn-cgi/trace', reads: true }),
});
const MAX_BODY_BYTES = 32_768;
const targets = Object.freeze({
  quota: Object.freeze({ url: 'https://www.runninghub.ai/openapi/v2/api-key/list', method: 'GET' }),
  seller: Object.freeze({ url: 'https://www.runninghub.ai/api/key/queryAllV2', method: 'POST' }),
});
const safeCodes = new Set([
  'ENOTFOUND', 'ENODATA', 'EAI_AGAIN', 'ECANCELLED', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  'EHOSTUNREACH', 'ENETUNREACH', 'ABORT_ERR', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_SSL_WRONG_VERSION_NUMBER', 'BODY_TOO_LARGE', 'INVALID_JSON',
  'EPIPE', 'EACCES', 'EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EPROTO',
  'ERR_TLS_HANDSHAKE_TIMEOUT', 'CERT_NOT_YET_VALID', 'SELF_SIGNED_CERT_IN_CHAIN',
]);
const safeNames = new Set(['Error', 'TypeError', 'AbortError', 'TimeoutError', 'AggregateError']);
const safeBusinessNames = new Set(['HEADER_API_KEY_NOT_FOUND', 'APIKEY_USER_NOT_FOUND', 'TOKEN_MISSION', 'TOKEN_INVALID']);

export function safeFailure(error) {
  const names = new Set(), codes = new Set(), seen = new Set();
  const inspect = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 3 || seen.has(value)) return;
    seen.add(value);
    if (safeNames.has(value.name)) names.add(value.name);
    if (safeCodes.has(value.code)) codes.add(value.code);
    inspect(value.cause, depth + 1);
    if (Array.isArray(value.errors)) for (const child of value.errors.slice(0, 4)) inspect(child, depth + 1);
  };
  inspect(error);
  return { names: [...names], codes: [...codes], ...(names.size || codes.size ? {} : { kind: 'NETWORK_FAILURE' }) };
}
function labeledError(code) { return Object.assign(new Error(), { code }); }
function elapsed(start) { return Math.max(0, Math.round(performance.now() - start)); }
function businessResult(text) {
  let envelope;
  try { envelope = JSON.parse(text); } catch { throw labeledError('INVALID_JSON'); }
  const code = envelope?.code;
  const providerCode = (typeof code === 'number' && Number.isSafeInteger(code) && code >= 0 && code <= 999999)
    || (typeof code === 'string' && /^\d{1,6}$/.test(code)) ? String(code) : 'UNRECOGNIZED';
  return { providerCode, ...(safeBusinessNames.has(envelope?.msg) ? { providerName: envelope.msg } : {}) };
}
async function boundedText(body) {
  if (!body) return '';
  const reader = body.getReader();
  let bytes = 0, text = '';
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw labeledError('BODY_TOO_LARGE');
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function probeFetch(targetName, transport = directFetch) {
  const target = targets[targetName];
  if (!target) throw new Error('Unknown diagnostic target.');
  const start = performance.now();
  let status;
  try {
    const response = await transport(target.url, { method: target.method,
      headers: { Accept: 'application/json', ...(target.method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
      ...(target.method === 'POST' ? { body: '{}' } : {}),
      credentials: 'omit', redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
    status = response.status;
    if (status >= 300 && status < 400) { await response.body?.cancel(); return { target: targetName, transport: 'node-fetch', status, redirected: true, elapsedMs: elapsed(start) }; }
    return { target: targetName, transport: 'node-fetch', status,
      ...businessResult(await boundedText(response.body)), elapsedMs: elapsed(start) };
  } catch (error) {
    return { target: targetName, transport: 'node-fetch', ...(status === undefined ? {} : { status }),
      ...safeFailure(error), elapsedMs: elapsed(start) };
  }
}
export async function probeHttps(targetName, transport = request) {
  const target = targets[targetName];
  if (!target) throw new Error('Unknown diagnostic target.');
  const start = performance.now();
  let status;
  try {
    const result = await new Promise((resolve, reject) => {
      let settled = false, response;
      const finish = (error, value) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (error) reject(error); else resolve(value);
      };
      const req = transport(target.url, { method: target.method,
        headers: { Accept: 'application/json', ...(target.method === 'POST' ? { 'Content-Type': 'application/json' } : {}) } }, res => {
        response = res; status = res.statusCode;
        if (status >= 300 && status < 400) { finish(null, { redirected: true }); res.destroy(); return; }
        const chunks = []; let size = 0;
        res.on('data', chunk => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) { finish(labeledError('BODY_TOO_LARGE')); res.destroy(); req.destroy(); }
          else chunks.push(chunk);
        });
        res.once('error', error => finish(error));
        res.once('end', () => {
          try { finish(null, businessResult(Buffer.concat(chunks).toString('utf8'))); }
          catch (error) { finish(error); }
        });
      });
      const timer = setTimeout(() => { finish(labeledError('ETIMEDOUT')); response?.destroy(); req.destroy(); }, TIMEOUT_MS);
      req.once('error', error => finish(error));
      req.end(target.method === 'POST' ? '{}' : undefined);
    });
    return { target: targetName, transport: 'native-https', status, ...result, elapsedMs: elapsed(start) };
  } catch (error) {
    return { target: targetName, transport: 'native-https', ...(status === undefined ? {} : { status }),
      ...safeFailure(error), elapsedMs: elapsed(start) };
  }
}
export async function probeDns(resolvers) {
  const start = performance.now();
  const resolver = resolvers ?? new Resolver({ timeout: TIMEOUT_MS, tries: 1 });
  const deadline = resolvers ? null : setTimeout(() => resolver.cancel(), TIMEOUT_MS);
  try { return await Promise.all([4, 6].map(async family => {
    try {
      const addresses = await resolver[family === 4 ? 'resolve4' : 'resolve6'](PROVIDER_HOST);
      return { transport: 'dns', family, addresses: addresses.filter(address => isIP(address) === family).slice(0, 8), elapsedMs: elapsed(start) };
    } catch (error) { return { transport: 'dns', family, ...safeFailure(error), elapsedMs: elapsed(start) }; }
  })); } finally { if (deadline) clearTimeout(deadline); }
}
function safeProtocol(value) {
  return typeof value === 'string' && /^TLSv1(?:\.[0-3])?$/.test(value) ? value : undefined;
}

// Raw TCP reachability. Separates a silently dropped SYN (ETIMEDOUT) from a
// refused port (ECONNREFUSED) and from a later TLS or HTTP failure.
export function probeTcp(address, port = 443, timeoutMs = REACH_TIMEOUT_MS, create = () => new Socket()) {
  const start = performance.now();
  return new Promise(resolve => {
    const socket = create();
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch { /* The probe result is already decided. */ }
      resolve({ transport: 'tcp', address, ...(isIP(address) ? { family: isIP(address) } : {}), ...result, elapsedMs: elapsed(start) });
    };
    const timer = setTimeout(() => finish(safeFailure(labeledError('ETIMEDOUT'))), timeoutMs);
    socket.once('error', error => finish(safeFailure(error)));
    socket.connect({ host: address, port }, () => finish({ connected: true }));
  });
}

// TLS handshake with the real hostname as SNI and full certificate verification.
export function probeTls(address, servername = PROVIDER_HOST, timeoutMs = REACH_TIMEOUT_MS, create = tlsConnect) {
  const start = performance.now();
  return new Promise(resolve => {
    let settled = false, socket;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.destroy(); } catch { /* The probe result is already decided. */ }
      resolve({ transport: 'tls', address, ...(isIP(address) ? { family: isIP(address) } : {}), ...result, elapsedMs: elapsed(start) });
    };
    const timer = setTimeout(() => finish(safeFailure(labeledError('ETIMEDOUT'))), timeoutMs);
    socket = create({ host: address, port: 443, servername, ALPNProtocols: ['http/1.1'] }, () => {
      const protocol = safeProtocol(socket.getProtocol?.());
      finish(socket.authorized
        ? { connected: true, authorized: true, ...(protocol ? { protocol } : {}) }
        : { connected: true, authorized: false, ...(protocol ? { protocol } : {}), ...safeFailure(socket.authorizationError) });
    });
    socket.once('error', error => finish(safeFailure(error)));
  });
}

function traceFacts(text) {
  const address = /^ip=([0-9a-fA-F.:]{3,45})$/m.exec(text)?.[1];
  const colo = /^colo=([A-Z]{3})$/m.exec(text)?.[1];
  return { ...(address && isIP(address) ? { egressAddress: address } : {}), ...(colo ? { egressColo: colo } : {}) };
}

// Credential-free control destinations. They prove whether outbound HTTPS works
// at all from this server, so a provider-only failure can be told apart from a
// blocked egress. Only the trace control's bounded body is read.
export async function probeControl(name, transport = directFetch) {
  const control = controls[name];
  if (!control) throw new Error('Unknown control destination.');
  const start = performance.now();
  let status;
  try {
    const response = await transport(control.url, { method: 'GET', headers: { Accept: '*/*' },
      credentials: 'omit', redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
    status = response.status;
    if (status >= 300 && status < 400) {
      await response.body?.cancel();
      return { transport: 'control', target: name, status, redirected: true, elapsedMs: elapsed(start) };
    }
    if (!control.reads || status !== 200) {
      await response.body?.cancel();
      return { transport: 'control', target: name, status, elapsedMs: elapsed(start) };
    }
    return { transport: 'control', target: name, status, ...traceFacts(await boundedText(response.body)), elapsedMs: elapsed(start) };
  } catch (error) {
    return { transport: 'control', target: name, ...(status === undefined ? {} : { status }),
      ...safeFailure(error), elapsedMs: elapsed(start) };
  }
}

// One pass that separates DNS, TCP, TLS and HTTP, and compares the provider
// against control destinations and against alternate provider edge addresses.
export async function runNetworkReport(options = {}) {
  const dns = await (options.dns ?? probeDns());
  const resolved = dns.flatMap(entry => Array.isArray(entry.addresses) ? entry.addresses : []);
  const addresses = [...new Set([...resolved, ...ALTERNATE_ADDRESSES])].slice(0, 6);
  const [reach, http, controlResults] = await Promise.all([
    Promise.all(addresses.flatMap(address => [
      probeTcp(address).then(result => ({ ...result, ...(resolved.includes(address) ? {} : { alternate: true }) })),
      probeTls(address).then(result => ({ ...result, ...(resolved.includes(address) ? {} : { alternate: true }) })),
    ])),
    Promise.all([probeFetch('quota'), probeHttps('quota'), probeFetch('seller'), probeHttps('seller')]),
    Promise.all(Object.keys(controls).map(name => probeControl(name))),
  ]);
  return [...dns, ...reach, ...http, ...controlResults];
}

export async function main() {
  for (const result of await runNetworkReport()) console.log(JSON.stringify(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length > 2) {
    console.error('Usage: node hostinger/diagnose-runninghub.mjs (no credentials or arguments)');
    process.exitCode = 1;
  } else await main();
}

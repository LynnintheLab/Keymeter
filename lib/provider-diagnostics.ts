const networkCodes = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  'EHOSTUNREACH', 'ENETUNREACH', 'ABORT_ERR', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_SSL_WRONG_VERSION_NUMBER',
]);
const errorNames = new Set(['Error', 'TypeError', 'AbortError', 'TimeoutError', 'AggregateError']);

// Provider errors can contain request URLs, keys, headers and response bodies.
// Only fixed, recognized diagnostic labels may reach the operator's logs.
export function providerNetworkFailure(operation: 'quota' | 'billing', error: unknown): void {
  const names = new Set<string>(), codes = new Set<string>();
  const seen = new Set<unknown>();
  function inspect(value: unknown, depth: number) {
    if (!value || typeof value !== 'object' || depth > 3 || seen.has(value)) return;
    seen.add(value);
    const row = value as Record<string, unknown>;
    if (typeof row.name === 'string' && errorNames.has(row.name)) names.add(row.name);
    if (typeof row.code === 'string' && networkCodes.has(row.code)) codes.add(row.code);
    inspect(row.cause, depth + 1);
    if (Array.isArray(row.errors)) for (const child of row.errors.slice(0, 4)) inspect(child, depth + 1);
  }
  try {
    inspect(error, 0);
    console.warn('[Keymeter provider network]', JSON.stringify({ operation,
      names: [...names], codes: [...codes], ...(names.size || codes.size ? {} : { kind: 'NETWORK_FAILURE' }) }));
  } catch { /* Diagnostics must never replace the original provider failure. */ }
}

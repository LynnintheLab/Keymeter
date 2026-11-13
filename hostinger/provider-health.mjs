import { probeDns, probeFetch, probeHttps } from './diagnose-runninghub.mjs';

// Deliberately accepts no caller-supplied URLs, headers, tokens or request data.
// These anonymous probes never read the saved seller connection or environment.
export async function runProviderDiagnostics() {
  const checkedAt = new Date().toISOString();
  const results = await Promise.all([
    probeDns(), probeFetch('quota'), probeHttps('quota'), probeFetch('seller'), probeHttps('seller'),
  ]);
  return { checkedAt, probes: results.flat() };
}

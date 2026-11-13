import { runNetworkReport } from './diagnose-runninghub.mjs';

// Deliberately accepts no caller-supplied URLs, headers, tokens or request data.
// These anonymous probes never read the saved seller connection or environment.
export async function runProviderDiagnostics() {
  const checkedAt = new Date().toISOString();
  return { checkedAt, probes: await runNetworkReport() };
}

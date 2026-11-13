'use client';

import { useEffect, useRef, useState } from 'react';
import styles from './connection-diagnostics.module.css';

type Probe = {
  target?: 'quota' | 'seller' | 'apex' | 'mail' | 'trace';
  transport: 'dns' | 'node-fetch' | 'native-https' | 'tcp' | 'tls' | 'control';
  family?: 4 | 6;
  address?: string;
  addresses?: string[];
  connected?: boolean;
  authorized?: boolean;
  protocol?: string;
  alternate?: boolean;
  egressAddress?: string;
  egressColo?: string;
  status?: number;
  providerCode?: string;
  providerName?: string;
  names?: string[];
  codes?: string[];
  kind?: 'NETWORK_FAILURE';
  redirected?: boolean;
  elapsedMs: number;
};
type Report = { checkedAt: string; probes: Probe[] };

const errorNames = new Set(['Error', 'TypeError', 'AbortError', 'TimeoutError', 'AggregateError']);
const errorCodes = new Set([
  'ENOTFOUND', 'ENODATA', 'EAI_AGAIN', 'ECANCELLED', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  'EHOSTUNREACH', 'ENETUNREACH', 'ABORT_ERR', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_SSL_WRONG_VERSION_NUMBER', 'BODY_TOO_LARGE', 'INVALID_JSON',
  'EPIPE', 'EACCES', 'EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EPROTO',
  'ERR_TLS_HANDSHAKE_TIMEOUT', 'CERT_NOT_YET_VALID', 'SELF_SIGNED_CERT_IN_CHAIN',
]);
const transports = new Set(['dns', 'node-fetch', 'native-https', 'tcp', 'tls', 'control']);
const targets = new Set(['quota', 'seller', 'apex', 'mail', 'trace']);
const addressPattern = /^[0-9a-f.:]{3,45}$/i;
const protocolPattern = /^TLSv1(?:\.[0-3])?$/;
const providerNames = new Set(['HEADER_API_KEY_NOT_FOUND', 'APIKEY_USER_NOT_FOUND', 'TOKEN_MISSION', 'TOKEN_INVALID']);

// Copy only diagnostic labels; never include arbitrary response text or credentials.
function safeReport(value: unknown): Report {
  if (!value || typeof value !== 'object') throw new Error();
  const report = value as Record<string, unknown>;
  if (typeof report.checkedAt !== 'string' || !Number.isFinite(Date.parse(report.checkedAt))
    || !Array.isArray(report.probes) || report.probes.length < 1 || report.probes.length > 40) throw new Error();
  const probes: Probe[] = report.probes.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new Error();
    const probe = item as Record<string, unknown>;
    if (!transports.has(String(probe.transport))
      || typeof probe.elapsedMs !== 'number' || !Number.isFinite(probe.elapsedMs)
      || probe.elapsedMs < 0 || probe.elapsedMs > 60_000) throw new Error();
    const result: Probe = { transport: probe.transport as Probe['transport'], elapsedMs: Math.round(probe.elapsedMs) };
    if (typeof probe.target === 'string' && targets.has(probe.target)) result.target = probe.target as Probe['target'];
    if (probe.family === 4 || probe.family === 6) result.family = probe.family;
    if (typeof probe.address === 'string' && addressPattern.test(probe.address)) result.address = probe.address;
    if (Array.isArray(probe.addresses)) result.addresses = probe.addresses
      .filter((value): value is string => typeof value === 'string' && addressPattern.test(value)).slice(0, 8);
    if (probe.connected === true) result.connected = true;
    if (typeof probe.authorized === 'boolean') result.authorized = probe.authorized;
    if (typeof probe.protocol === 'string' && protocolPattern.test(probe.protocol)) result.protocol = probe.protocol;
    if (probe.alternate === true) result.alternate = true;
    if (typeof probe.egressAddress === 'string' && addressPattern.test(probe.egressAddress)) result.egressAddress = probe.egressAddress;
    if (typeof probe.egressColo === 'string' && /^[A-Z]{3}$/.test(probe.egressColo)) result.egressColo = probe.egressColo;
    if (typeof probe.status === 'number' && Number.isInteger(probe.status) && probe.status >= 100 && probe.status <= 599) result.status = probe.status;
    if (typeof probe.providerCode === 'string' && (/^\d{1,6}$/.test(probe.providerCode) || probe.providerCode === 'UNRECOGNIZED')) result.providerCode = probe.providerCode;
    if (typeof probe.providerName === 'string' && providerNames.has(probe.providerName)) result.providerName = probe.providerName;
    if (Array.isArray(probe.names)) result.names = probe.names.filter((name): name is string => typeof name === 'string' && errorNames.has(name)).slice(0, 5);
    if (Array.isArray(probe.codes)) result.codes = probe.codes.filter((code): code is string => typeof code === 'string' && errorCodes.has(code)).slice(0, 8);
    if (probe.kind === 'NETWORK_FAILURE') result.kind = probe.kind;
    if (probe.redirected === true) result.redirected = true;
    return result;
  });
  return { checkedAt: new Date(report.checkedAt).toISOString(), probes };
}

function labels(probe: Probe) {
  const resolved = probe.transport === 'dns'
    ? (probe.addresses?.length ? probe.addresses.join(', ') : 'No addresses returned')
    : undefined;
  return [resolved, probe.connected && (probe.transport === 'tcp' ? 'Port 443 open' : 'Handshake completed'),
    probe.authorized === true && 'Certificate verified', probe.authorized === false && 'Certificate not verified',
    probe.protocol, probe.status && `HTTP ${probe.status}`, probe.providerCode && `Code ${probe.providerCode}`,
    probe.providerName, probe.egressAddress && `Egress ${probe.egressAddress}`, probe.egressColo,
    ...probe.codes ?? [], ...probe.names ?? [], probe.kind,
    probe.redirected && 'Redirect received'].filter(Boolean).join(' · ') || 'Completed';
}

function rowTitle(probe: Probe) {
  if (probe.transport === 'dns') return `DNS · IPv${probe.family ?? '?'}`;
  if (probe.transport === 'tcp') return `TCP 443${probe.alternate ? ' · alternate node' : ''}`;
  if (probe.transport === 'tls') return `TLS${probe.alternate ? ' · alternate node' : ''}`;
  if (probe.transport === 'control')
    return probe.target === 'apex' ? 'Control · runninghub.ai'
      : probe.target === 'mail' ? 'Control · email API' : 'Control · network trace';
  return probe.target === 'quota' ? 'Balance API' : 'Billing API';
}

function rowDetail(probe: Probe) {
  if (probe.transport === 'node-fetch') return 'Node fetch';
  if (probe.transport === 'native-https') return 'Native HTTPS';
  if (probe.transport === 'dns') return 'Domain lookup';
  if (probe.transport === 'control') return 'Reachability control';
  return probe.address ?? '';
}

export default function ConnectionDiagnostics() {
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const active = useRef<AbortController | null>(null);

  useEffect(() => () => active.current?.abort(), []);

  async function diagnose() {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setReport(null);
    setError('');
    setCopyStatus('');
    try {
      const response = await fetch('/api/seller/diagnostics', {
        method: 'POST', credentials: 'same-origin', mode: 'same-origin', redirect: 'error',
        cache: 'no-store', headers: { Accept: 'application/json' },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) setError('Sign in again to test the connection.');
        else if (response.status === 429) setError('Please wait a minute before testing again.');
        else setError('The connection test could not run. Please try again.');
        return;
      }
      setReport(safeReport(await response.json()));
    } catch {
      if (!controller.signal.aborted) setError('The connection test did not finish. Please try again.');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      if (active.current === controller) active.current = null;
    }
  }

  async function copyReport() {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      setCopyStatus('Report copied.');
    } catch {
      setCopyStatus('Copy is unavailable in this browser.');
    }
  }

  return (
    <section className={`setupPanel ${styles.panel}`} aria-labelledby="diagnostics-title" aria-busy={busy}>
      <div className={styles.heading}>
        <div><h2 id="diagnostics-title">Connection test</h2><p>Check this server’s route to RunningHub layer by layer, against control destinations. No API keys or RunningHub tokens are sent.</p></div>
        <button className="secondaryButton" type="button" onClick={() => void diagnose()} disabled={busy}>{busy ? 'Testing…' : 'Test connection'}</button>
      </div>
      {busy && <p className={styles.message} role="status">Testing DNS, TCP, TLS, both HTTP transports and control destinations. This can take 15 seconds.</p>}
      {error && <p className={styles.message} role="alert">{error}</p>}
      {report && <>
        <div className={styles.results} role="list" aria-label="Connection test results">
          {report.probes.map((probe, index) => <div className={styles.probe} role="listitem" key={`${probe.target}-${probe.transport}-${probe.family}-${probe.address}-${index}`}>
            <div className={styles.target}>{rowTitle(probe)}<span>{rowDetail(probe)}</span></div>
            <code className={styles.result}>{labels(probe)}</code>
            <span className={styles.elapsed}>{(probe.elapsedMs / 1000).toFixed(2)} s</span>
          </div>)}
        </div>
        <div className={styles.footer}><p>Checked {new Date(report.checkedAt).toLocaleString()}</p><button className="secondaryButton" type="button" onClick={() => void copyReport()}>Copy report</button></div>
        <p className={styles.copyStatus} role="status">{copyStatus}</p>
        <p className={styles.note}>Missing-key or missing-token responses mean RunningHub was reached. This test does not change your saved connection.</p>
      </>}
    </section>
  );
}

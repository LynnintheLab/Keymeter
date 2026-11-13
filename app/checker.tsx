'use client';
import { useEffect, useRef, useState } from 'react';
import type { Allowance } from '@/lib/quota';
import type { HistoryEntry } from '@/lib/history';
import type { PricePackage } from '@/lib/pricing';
import TopUpOffer from './top-up-offer';
import DigimiumAd from './digimium-ad';

type TaskHistory = {
  state: 'loading' | 'ready' | 'not_connected' | 'not_enrolled' | 'not_found' | 'reconnect' | 'unavailable';
  records: {
    taskId: string;
    time: string;
    name: string;
    status: string;
    cost: number | null;
    currency: string;
  }[];
  hasMore: boolean;
};
type AllowanceResult = Allowance & { history: HistoryEntry[] | null; tasks?: TaskHistory };
const money = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 6,
}).format;
const localDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const localTime = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

function KeyIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" aria-hidden="true"><circle cx="8" cy="9" r="4.5" /><path d="m11.5 12.5 7 7 2-2-1.5-1.5 1-1-2-2-1 1-3.5-3.5" /></svg>;
}

const tickCount = 45;

function BalanceGauge({ fraction }: { fraction: number }) {
  const percent = Math.round(fraction * 100);
  const filledTicks = Math.round(fraction * tickCount);

  return (
    <svg className="gauge" viewBox="0 0 240 122" role="img" aria-label={`${percent} percent remaining`}>
      <path className="rim" d="M18 115a102 102 0 0 1 204 0" />
      {Array.from({ length: tickCount }, (_, index) => {
        const angle = Math.PI * (1 - index / (tickCount - 1));
        const x = Math.cos(angle);
        const y = Math.sin(angle);

        return (
          <line
            key={index}
            x1={120 + 83 * x}
            y1={115 - 83 * y}
            x2={120 + 96 * x}
            y2={115 - 96 * y}
            stroke={index < filledTicks ? 'var(--signal)' : 'var(--tick)'}
            strokeWidth="3.7"
          />
        );
      })}
      <text x="120" y="91" textAnchor="middle">{percent}%</text>
      <text className="tickLabel" x="120" y="112" textAnchor="middle">REMAINING</text>
    </svg>
  );
}

function formatCharge(value: number, currency: string) {
  if (!/^[A-Z]{3}$/.test(currency)) return `${value.toFixed(6)} ${currency}`;
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 6,
  }).format(value);
}
function TaskUsage({ result }: { result: AllowanceResult }) {
  const tasks = result.tasks;
  const records = tasks?.state === 'ready' ? tasks.records : [];
  let message = '';
  switch (tasks?.state) {
    case 'loading':
      message = 'Loading job history…';
      break;
    case 'ready':
      message = records.length ? '' : 'No billed jobs in the last 30 days.';
      break;
    case 'not_enrolled':
    case 'not_found':
      message = 'Job history isn’t available for this key.';
      break;
    case 'reconnect':
      message = 'Balance checked. The seller needs to reconnect for job history.';
      break;
    case 'unavailable':
      message = 'Balance checked. Job history is temporarily unavailable.';
      break;
    default:
      message = 'Balance checked. The seller hasn’t connected job history yet.';
  }
  return (
    <section id="usage-history" className="keyHistory" aria-labelledby="usageTitle" aria-busy={tasks?.state === 'loading'} tabIndex={-1}>
      <div className="keySectionHeading">
        <h2 id="usageTitle">Usage history</h2>
        <span>Last 30 days · local time</span>
      </div>
      {message && <p className="keyHistoryEmpty" role="status">{message}</p>}
      {records.length > 0 && <table className="keyTable" aria-label="Individual job charges, newest first">
        <thead><tr><th scope="col">Time</th><th scope="col">Job / model</th><th scope="col">Status</th><th scope="col">Cost</th></tr></thead>
        <tbody>{records.map(record => {
          const started = new Date(record.time);
          return <tr key={record.taskId}>
            <th scope="row"><time dateTime={record.time}>{localDate.format(started)}<span>{localTime.format(started)}</span></time></th>
            <td className="keyTaskName" title={`Task ${record.taskId}`}><span className="keyMobileLabel" aria-hidden="true">Job / model</span>{record.name}</td>
            <td className="keyTaskStatus"><span className="keyMobileLabel" aria-hidden="true">Status</span>{record.status}</td>
            <td className="keyTaskCost"><span className="keyMobileLabel" aria-hidden="true">Cost</span>{record.cost === null ? 'Not reported' : formatCharge(record.cost, record.currency)}</td>
          </tr>;
        })}</tbody>
      </table>}
      {tasks?.hasMore && <p className="keyFootnote">Latest 50 jobs shown.</p>}
    </section>
  );
}
function BalanceChecks({ result }: { result: AllowanceResult }) {
  const entries = result.history;
  return <details className="keyReadings">
    <summary>Balance checks<span>{entries ? entries.length : 'Unavailable'}</span></summary>
    {!entries ? <p className="keyFootnote">Saved readings are temporarily unavailable.</p> : entries.length === 0 ? <p className="keyFootnote">No saved readings yet.</p> : <>
      <p className="keyFootnote">Saved when this key is checked.</p>
      <table className="keyTable keyReadingsTable" aria-label="Saved balance checks, newest first">
        <thead><tr><th scope="col">Checked</th><th scope="col">Change</th><th scope="col">Used</th><th scope="col">Remaining</th></tr></thead>
        <tbody>{entries.map((entry, index) => {
          const checked = new Date(entry.checkedAt);
          const change = entry.change === null ? 'First check' : (entry.change > 0 ? '+' : '') + money(entry.change);
          return <tr key={entry.checkedAt + index}>
            <th scope="row"><time dateTime={entry.checkedAt}>{localDate.format(checked)}<span>{localTime.format(checked)}</span></time></th>
            <td><span className="keyMobileLabel" aria-hidden="true">Change</span>{change}</td>
            <td><span className="keyMobileLabel" aria-hidden="true">Used</span>{money(entry.used)}</td>
            <td><span className="keyMobileLabel" aria-hidden="true">Remaining</span>{entry.remaining === null ? 'No limit reported' : money(entry.remaining)}</td>
          </tr>;
        })}</tbody>
      </table>
    </>}
  </details>;
}

export default function Checker({ initialPackages }: { initialPackages: PricePackage[] | null }) {
  const [key, setKey] = useState('');
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<AllowanceResult | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const activeRequest = useRef<AbortController | null>(null);
  const requestSequence = useRef(0);
  useEffect(() => () => {
    requestSequence.current++;
    activeRequest.current?.abort();
  }, []);
  function changeKey(value: string) {
    requestSequence.current++;
    activeRequest.current?.abort();
    activeRequest.current = null;
    setKey(value);
    setError('');
    setResult(null);
    setBusy(false);
  }
  async function loadTasks(value: string, sequence: number, controller: AbortController) {
    let tasks: TaskHistory;
    try {
      const response = await fetch('/api/usage-history', {
        method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: value }), signal: controller.signal,
      });
      if (!response.ok) throw new Error('History unavailable');
      const payload = await response.json() as TaskHistory;
      if (!['ready', 'not_connected', 'not_enrolled', 'not_found', 'reconnect', 'unavailable'].includes(payload?.state) ||
          !Array.isArray(payload.records) || typeof payload.hasMore !== 'boolean') throw new Error('Invalid history');
      tasks = payload;
    } catch {
      if (controller.signal.aborted || sequence !== requestSequence.current) return;
      tasks = { state: 'unavailable', records: [], hasMore: false };
    }
    if (controller.signal.aborted || sequence !== requestSequence.current) return;
    setResult(current => sequence === requestSequence.current && current ? { ...current, tasks } : current);
    if (activeRequest.current === controller) activeRequest.current = null;
  }
  async function check(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const sequence = ++requestSequence.current;
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setError('');
    setResult(null);
    const value = key.trim();
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(value)) {
      setError('Enter your full API key. Masked keys won’t work.');
      input.current?.focus();
      return;
    }
    setBusy(true);
    setShown(false);
    try {
      const response = await fetch('/api/allowance', {
        method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: value, includeTasks: false }), signal: controller.signal,
      });
      if (controller.signal.aborted || sequence !== requestSequence.current) return;
      if (!response.ok) {
        const payload = (await response.json()) as { error?: string };
        if (controller.signal.aborted || sequence !== requestSequence.current) return;
        setError(payload.error || 'Unable to check this key. Try again.');
        return;
      }
      const payload = await response.json() as AllowanceResult;
      if (controller.signal.aborted || sequence !== requestSequence.current) return;
      setResult({ ...payload, tasks: { state: 'loading', records: [], hasMore: false } });
      setKey('');
      setBusy(false);
      void loadTasks(value, sequence, controller);
    } catch {
      if (!controller.signal.aborted && sequence === requestSequence.current)
        setError('Couldn’t connect. Please try again.');
    } finally { if (sequence === requestSequence.current) setBusy(false); }
  }
  const warning = result?.state === 'expired' ? 'Key expired' : result?.state === 'exhausted' ? 'Spending limit reached' : '';
  const fraction = result && result.limit !== null && result.remaining !== null
    ? result.limit === 0 ? 0 : Math.max(0, Math.min(1, result.remaining / result.limit))
    : null;
  return <section className="keyWorkspace">
    <div className="keyLookup">
    <div className="keyEntry">
      <div className="keyHeading"><h1>Key allowance</h1><p>Check your RunningHub balance and job charges.</p></div>
      <form className="keyForm" onSubmit={check} autoComplete="off">
        <label htmlFor="key">Your API key</label>
        <div className="keyFormRow">
          <div className="inputWrap keyInputWrap">
            <KeyIcon />
            <input id="key" ref={input} type={shown ? 'text' : 'password'} autoComplete="off" spellCheck={false} autoCapitalize="none" maxLength={128} disabled={busy} value={key} placeholder="Paste your key" aria-describedby={'keyPrivacy' + (error ? ' keyError' : '')} aria-invalid={!!error} onChange={e => changeKey(e.target.value)} />
            <button className="show" type="button" disabled={busy} aria-label={shown ? 'Hide API key' : 'Show API key'} aria-pressed={shown} onClick={() => setShown(!shown)}>{shown ? 'Hide' : 'Show'}</button>
          </div>
          <button className="submit keySubmit" disabled={busy} type="submit">{busy ? 'Checking…' : 'Check balance'}<span aria-hidden="true">→</span></button>
        </div>
        {error && <p className="error keyError" role="alert" id="keyError">{error}</p>}
        <p id="keyPrivacy" className="keyPrivacy"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="4.5" y="8" width="11" height="9" rx="2" /><path d="M7 8V5.5a3 3 0 0 1 6 0V8" /></svg>Read-only · your key isn’t saved</p>
      </form>
    </div>
    <div className="keyResultArea" aria-busy={busy} aria-live="polite">
      {result ? <>
        <section className="keyBalancePanel" aria-labelledby="remainingTitle">
          <div className="keyBalanceMeta"><span>Key ····{result.suffix}</span><span className="keyChecked"><i aria-hidden="true" />Checked {localTime.format(new Date(result.checkedAt))}</span></div>
          {fraction !== null && <BalanceGauge fraction={fraction} />}
          <div className="keyBalanceAmount"><h2 id="remainingTitle">{result.remaining === null ? 'Spending limit' : 'Remaining allowance'}</h2><strong className={result.remaining === null ? 'keyNoLimit' : undefined}>{result.remaining === null ? 'No limit reported' : money(result.remaining)}</strong></div>
          <dl className="keyMetrics"><div><dt>Limit</dt><dd>{result.limit === null ? 'Not reported' : money(result.limit)}</dd></div><div><dt>Used</dt><dd>{money(result.used)}</dd></div></dl>
          {warning && <p className="keyWarning">{warning}</p>}
        </section>
      </> : busy ? <div className="keyLoading" role="status"><div className="keySkeleton keySkeletonShort" /><div className="keySkeleton keySkeletonLarge" /><div className="keySkeleton" /><p>Checking balance…</p></div> : <div className="keyInitial"><div className="keyInitialIcon"><KeyIcon /></div><p>{error ? 'No balance available' : 'No key checked'}</p><span>{error ? 'Check your key and try again.' : 'Your allowance will appear here.'}</span></div>}
    </div>
    </div>
    <DigimiumAd />
    {result && <div className="keyHistoryArea"><TaskUsage result={result} /><BalanceChecks result={result} /></div>}
    <TopUpOffer initialPackages={initialPackages} />
  </section>;
}

'use client';

import { useEffect, useState } from 'react';
import { packageBadge, USD_PACKAGES, validatePackages } from '@/lib/pricing';
import styles from './pricing-settings.module.css';

type Draft = Record<number, string>;
const draftFor = (packages: { usd: number; kyat: number }[]) => Object.fromEntries(packages.map(row => [row.usd, String(row.kyat)]));

export default function PricingSettings() {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/seller/pricing', { cache: 'no-store', signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Pricing could not be loaded. Refresh this page to retry.');
      const payload = await response.json() as { packages?: unknown; error?: unknown };
      if (!controller.signal.aborted) setDraft(draftFor(validatePackages(payload.packages)));
    }).catch(error => {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Pricing could not be loaded.');
    }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, []);
  async function save(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !draft) return;
    setError('');
    setNotice('');
    let packages;
    try { packages = validatePackages(USD_PACKAGES.map(usd => ({ usd, kyat: Number(draft[usd]) }))); }
    catch { setError('Enter a whole-number Ks price for every package.'); return; }
    setBusy(true);
    try {
      const response = await fetch('/api/seller/pricing', { method: 'PUT', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ packages }) });
      const payload = await response.json() as { packages?: unknown; error?: unknown };
      if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : 'Prices could not be saved.');
      setDraft(draftFor(validatePackages(payload.packages)));
      setNotice('Prices updated. The customer popup will show these prices when opened.');
    } catch (error) { setError(error instanceof Error ? error.message : 'Prices could not be saved. Try again.'); }
    finally { setBusy(false); }
  }
  return <section className={styles.panel} aria-labelledby="pricingSettingsTitle">
    <h2 id="pricingSettingsTitle">API pricing</h2>
    <p>Edit the Ks prices shown in the customer top-up popup.</p>
    {busy && !draft && <p role="status">Loading prices…</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p className="success" role="status">{notice}</p>}
    {draft && <form onSubmit={save}>
      <div className={styles.rows}>{USD_PACKAGES.map(usd => <div className={styles.row} key={usd}>
        <label htmlFor={`price-${usd}`}><strong>{usd} USD</strong>{packageBadge(usd) && <span>{packageBadge(usd)}</span>}</label>
        <div className={styles.inputWrap}><input id={`price-${usd}`} type="number" inputMode="numeric" min={1} max={1_000_000_000} step={1} required value={draft[usd]} disabled={busy} aria-label={`${usd} USD price in Ks`}
          onChange={event => { setDraft({ ...draft, [usd]: event.target.value }); setNotice(''); }} /><span aria-hidden="true">Ks</span></div>
      </div>)}</div>
      <button className="submit" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save prices'}<span aria-hidden="true">→</span></button>
    </form>}
  </section>;
}

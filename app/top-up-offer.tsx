'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { packageBadge, validatePackages } from '@/lib/pricing';
import type { PricePackage } from '@/lib/pricing';
import styles from './top-up-offer.module.css';

const kyat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format;

function Arrow() {
  return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M5 15 15 5M5 5h10v10" /></svg>;
}

export default function TopUpOffer({ initialPackages }: { initialPackages: PricePackage[] | null }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const heading = useId();
  const contactHeading = useId();
  const contact = useId();
  const request = useRef<AbortController | null>(null);
  const lastRead = useRef(0);
  const [packages, setPackages] = useState<PricePackage[] | null>(initialPackages);
  const [loading, setLoading] = useState(!initialPackages);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setError('');
    setLoading(true);
    try {
      const response = await fetch('/api/pricing', { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error();
      const payload = await response.json() as { packages?: unknown };
      const next = validatePackages(payload.packages);
      if (!controller.signal.aborted) {
        setPackages(next);
        lastRead.current = Date.now();
      }
    } catch {
      if (!controller.signal.aborted) {
        setPackages(null);
        setError('Prices are temporarily unavailable.');
      }
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }, []);
  useEffect(() => {
    void load();
    const refresh = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastRead.current > 30_000) void load();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      request.current?.abort();
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [load]);

  return <>
    <aside className={styles.offer} aria-labelledby={heading}>
      <div className={styles.priceHeading}><h2 id={heading}>Running Hub<br />Enterprise Share Key</h2></div>
      <div className={styles.priceContent} aria-busy={loading}>
        {loading && !packages && <p className={styles.priceStatus} role="status">Loading current prices…</p>}
        {error && <div className={styles.priceStatus} role="status"><p>{error}</p><button className={styles.retry} type="button" onClick={() => void load()}>Retry prices</button></div>}
        {packages && <table className={styles.prices} aria-label="RunningHub key packages and prices in Myanmar kyat">
          <thead><tr><th scope="col">Amount</th><th scope="col">Price</th></tr></thead>
          <tbody>{packages.map(option => <tr key={option.usd} className={packageBadge(option.usd) ? styles.featured : undefined}>
            <th scope="row"><span className={styles.amount}>{option.usd} <small>USD</small></span>{packageBadge(option.usd) && <span className={styles.badge}>{packageBadge(option.usd)}</span>}</th>
            <td>{kyat(option.kyat)} <span>Ks</span></td>
          </tr>)}</tbody>
        </table>}
      </div>
      <div className={styles.offerFooter}>
        <button ref={trigger} className={styles.trigger} type="button" onClick={() => dialog.current?.showModal()} aria-haspopup="dialog">
          Top up my key <Arrow />
        </button>
      </div>
    </aside>
    <dialog ref={dialog} className={styles.modal} aria-labelledby={contactHeading} aria-describedby={contact} aria-modal="true"
      onClose={() => trigger.current?.focus()}
      onPointerDown={event => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)
          dialog.current?.close();
      }}>
      <div className={styles.contactHeading}>
        <h2 id={contactHeading}>Top up my key</h2>
        <button className={styles.close} type="button" aria-label="Close contacts" onClick={() => dialog.current?.close()} autoFocus>
          <svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m5 5 10 10M15 5 5 15" /></svg>
        </button>
      </div>
      <div className={styles.contactContent}>
        <p className={styles.contactCopy} id={contact} lang="my">API Key ဝယ်ရန် အောက်ပါ Telegram နှင့် Facebook တို့ကို ဆက်သွယ် နိုင်ပါတယ်ခင်ဗျ</p>
        <div className={styles.contacts}>
          <a href="https://t.me/LynnIsHeree" target="_blank" rel="noopener noreferrer">Telegram <Arrow /><span className={styles.srOnly}> (opens in a new tab)</span></a>
          <a href="https://www.facebook.com/profile.php?id=61579857132090" target="_blank" rel="noopener noreferrer">Facebook <Arrow /><span className={styles.srOnly}> (opens in a new tab)</span></a>
        </div>
      </div>
    </dialog>
  </>;
}

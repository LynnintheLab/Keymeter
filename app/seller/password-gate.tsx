'use client';

import { useState } from 'react';
import styles from './password-gate.module.css';

export function PasswordGate({ setup }: { setup: boolean }) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (setup && password !== confirmation) { setError('Passwords do not match.'); return; }
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/seller/auth', {
        method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: setup ? 'setup' : 'login', password }),
      });
      if (!response.ok) {
        const payload = await response.json() as { error?: string };
        if (response.status === 409) { window.location.reload(); return; }
        throw new Error(payload.error || 'Could not unlock billing. Try again.');
      }
      setPassword('');
      setConfirmation('');
      window.location.reload();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not unlock billing. Try again.');
      setBusy(false);
    }
  }
  return (
    <section className={styles.panel} aria-labelledby="billingPasswordTitle">
      <span className="smallCap">Owner access</span>
      <h1 id="billingPasswordTitle">{setup ? 'Protect your billing.' : 'Unlock billing.'}</h1>
      <p>{setup ? 'Choose a private password for billing settings.' : 'Enter your billing password to continue.'}</p>
      <form onSubmit={submit}>
        <label htmlFor="billingPassword">{setup ? 'New password' : 'Password'}</label>
        <input className={styles.input} id="billingPassword" type="password" autoComplete={setup ? 'new-password' : 'current-password'}
          minLength={16} maxLength={256} required disabled={busy} value={password}
          aria-describedby={setup ? 'billingPasswordHint' : error ? 'billingPasswordError' : undefined}
          onChange={event => { setPassword(event.target.value); setError(''); }} />
        {setup && <>
          <p id="billingPasswordHint" className={styles.hint}>At least 16 characters. Save it in your password manager.</p>
          <label htmlFor="billingPasswordAgain">Confirm password</label>
          <input className={styles.input} id="billingPasswordAgain" type="password" autoComplete="new-password" minLength={16} maxLength={256}
            required disabled={busy} value={confirmation} onChange={event => { setConfirmation(event.target.value); setError(''); }} />
        </>}
        {error && <p className="error" id="billingPasswordError" role="alert">{error}</p>}
        <button type="submit" className="submit" disabled={busy}>{busy ? 'Please wait…' : setup ? 'Set password & continue' : 'Unlock billing'}<span aria-hidden="true">→</span></button>
      </form>
      <p className={styles.privacy}>Locking billing keeps RunningHub connected.</p>
    </section>
  );
}

export function LockBilling() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function lock() {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch('/api/seller/auth', { method: 'DELETE', cache: 'no-store' });
      if (!response.ok) throw new Error();
      window.location.reload();
    } catch { setError('Could not lock billing. Try again.'); setBusy(false); }
  }
  return <div className={styles.toolbar}>
    {error && <span className="error" role="alert">{error}</span>}
    <button type="button" className="secondaryButton" disabled={busy} onClick={lock}>{busy ? 'Locking…' : 'Lock billing'}</button>
  </div>;
}

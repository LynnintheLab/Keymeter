'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import PricingSettings from './pricing-settings';

type Connection = {
  connected: boolean;
  keys: { id: string; mask: string; name: string }[];
  keyCount?: number;
  reconnect?: boolean;
  canRenew?: boolean;
  expiresAt?: string | null;
  unavailable?: boolean;
};

export default function BillingSetup({ standalone = false }: { standalone?: boolean }) {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [sessionToken, setSessionToken] = useState('');
  const [refreshToken, setRefreshToken] = useState('');
  const [renewalToken, setRenewalToken] = useState('');
  const [teamId, setTeamId] = useState('');
  const [busy, setBusy] = useState('loading');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/seller/billing', { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Seller setup could not be loaded. Refresh and try again.');
        setConnection(await response.json());
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy('');
      });
    return () => controller.abort();
  }, []);

  async function update(action: 'connect' | 'disconnect' | 'add-refresh') {
    if (busy) return;
    setBusy(action);
    setError('');
    setNotice('');
    try {
      const body = action === 'add-refresh'
        ? { action, refreshToken: renewalToken.trim() }
        : { action, sessionToken: sessionToken.trim(), refreshToken: refreshToken.trim(), teamId: teamId.trim() };
      const response = await fetch('/api/seller/billing', {
        method: action === 'disconnect' ? 'DELETE' : 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: action === 'disconnect' ? undefined : JSON.stringify(body),
      });
      if (!response.ok) {
        const payload = await response.json() as { error?: string };
        throw new Error(payload.error || 'The update could not be completed. Try again.');
      }
      if (action === 'connect') {
        setSessionToken('');
        setRefreshToken('');
      }
      if (action === 'add-refresh') setRenewalToken('');
      const statusResponse = await fetch('/api/seller/billing', { cache: 'no-store' });
      if (!statusResponse.ok) throw new Error('The update was sent, but connection status could not be refreshed. Refresh this page.');
      setConnection(await statusResponse.json());
      setNotice(action === 'add-refresh' ? 'Automatic renewal enabled. Your connection stays saved.' : action === 'connect' ? 'RunningHub connected. All shared keys are available automatically.' : 'RunningHub disconnected.');
    } catch (error) {
      setError(error instanceof Error ? error.message : 'The update could not be completed. Try again.');
    } finally {
      setBusy('');
    }
  }

  const keyCount = connection?.keyCount ?? connection?.keys?.length ?? 0;
  const expiration = connection?.expiresAt ? new Date(connection.expiresAt).toLocaleString() : null;

  return (
    <>
      <section className="sellerIntro">
        <span className="smallCap">Owner controls</span>
        <h1>Connect your billing.</h1>
        <p className="intro">Connect once for per-job charges. Customers can check their balance with their API key alone.</p>
        {standalone && <a className="textLink" href="/owner/email">Owner email &amp; security →</a>}
        <div className="connectionStatus" role="status">
          <i className={connection?.connected && !connection.reconnect && !connection.unavailable ? 'connectedDot' : ''} />
          {busy === 'loading' ? 'Loading connection…' : connection?.reconnect ? 'Reconnect RunningHub' : connection?.unavailable ? 'Connection saved · RunningHub temporarily unavailable' : connection?.connected ? 'RunningHub connected' : 'RunningHub not connected'}
          {connection?.connected && !connection.unavailable && <span>{keyCount} shared {keyCount === 1 ? 'key' : 'keys'} available automatically</span>}
        </div>
        {connection?.connected && <p className="setupDisclosure">Connection saved securely. {connection.canRenew ? 'Automatic renewal is on.' : 'Add a refresh token once below for automatic renewal.'}{expiration && <> Current access expires {expiration}.</>}</p>}
      </section>
      {error && <p className="error sellerMessage" role="alert">{error}</p>}
      {notice && <p className="success sellerMessage" role="status">{notice}</p>}
      <div className="sellerGrid">
        <section className="setupPanel" aria-labelledby="connectTitle">
          <span className="smallCap">01 · Connect</span>
          <h2 id="connectTitle">Your seller session</h2>
          <p>Connect the RunningHub account that owns your shared keys. Add its optional refresh token to renew access automatically when the session expires.</p>
          <details className="setupHelp">
            <summary>Where do I find the session token?</summary>
            <ol>
              <li>Open <a href="https://www.runninghub.ai/call-api/bill-task?tab=detail" target="_blank" rel="noreferrer">RunningHub billing</a> and sign in to the account that owns your sold keys.</li>
              <li>Open your browser’s developer tools. Select Application, then Local Storage for <code>https://www.runninghub.ai</code>.</li>
              <li>Copy <code>Rh-Accesstoken</code> into the session field. For automatic renewal, also copy <code>Rh-Refreshtoken</code> from the same storage area into the optional refresh-token field. If you use a team account, add its team ID.</li>
            </ol>
            <p>Use the seller login session token for this connection. Keep it private and enter it only on this owner page.</p>
          </details>
          <form onSubmit={(event) => { event.preventDefault(); void update('connect'); }} autoComplete="off">
            <label htmlFor="sessionToken">RunningHub session token</label>
            <input className="setupInput" id="sessionToken" type="password" autoComplete="off" spellCheck={false} autoCapitalize="none" value={sessionToken} onChange={(event) => setSessionToken(event.target.value)} disabled={!!busy} required maxLength={8192} />
            <label htmlFor="refreshToken">RunningHub refresh token <span className="optional">optional</span></label>
            <input className="setupInput" id="refreshToken" type="password" autoComplete="off" spellCheck={false} autoCapitalize="none" value={refreshToken} onChange={(event) => setRefreshToken(event.target.value)} disabled={!!busy} maxLength={8192} />
            <p className="setupDisclosure">A refresh token lets Keymeter renew the saved session automatically. Keep both tokens private and enter them only on this owner page.</p>
            <label htmlFor="teamId">Team ID <span className="optional">optional</span></label>
            <input className="setupInput" id="teamId" autoComplete="off" spellCheck={false} value={teamId} onChange={(event) => setTeamId(event.target.value)} disabled={!!busy} maxLength={128} />
            <p className="setupDisclosure">Connecting saves the seller session and optional renewal token encrypted on Keymeter’s server. The session can access seller-account data. Keymeter uses it to verify keys and read their billing records.</p>
            <button className="submit" type="submit" disabled={!!busy || !sessionToken.trim()}>{busy === 'connect' ? 'Connecting…' : connection?.connected ? 'Replace connection' : 'Connect RunningHub'}<span aria-hidden="true">↗</span></button>
          </form>
        </section>
        <section className="setupPanel" aria-labelledby="automaticTitle">
          <span className="smallCap">Automatic access</span>
          <h2 id="automaticTitle">All your shared keys</h2>
          <p>Balance checks need only the customer’s API key. This optional connection adds individual job charges for your current and future shared keys.</p>
          <p>Keymeter verifies each full key against your connected account before showing its job records.</p>
          {((connection?.connected && !connection.canRenew) || connection?.reconnect) && <form onSubmit={(event) => { event.preventDefault(); void update('add-refresh'); }} autoComplete="off">
            <h3>Keep the connection active</h3>
            <p>Save <code>Rh-Refreshtoken</code> from RunningHub once. Your access token is already saved.</p>
            <label htmlFor="renewalToken">RunningHub refresh token</label>
            <input className="setupInput" id="renewalToken" type="password" autoComplete="off" spellCheck={false} autoCapitalize="none" value={renewalToken} onChange={(event) => setRenewalToken(event.target.value)} disabled={!!busy} required maxLength={8192} />
            <button className="submit" type="submit" disabled={!!busy || !renewalToken.trim()}>{busy === 'add-refresh' ? 'Verifying…' : 'Enable automatic renewal'}<span aria-hidden="true">→</span></button>
          </form>}
          <Link className="textLink" href="/">Open the key checker →</Link>
          {connection?.connected && <div className="disconnect"><p>Disconnecting removes the stored seller session and stops automatic job-history access.</p><button className="secondaryButton" type="button" disabled={!!busy} onClick={() => void update('disconnect')}>{busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect RunningHub'}</button></div>}
        </section>
      </div>
      <PricingSettings />
      <Link className="textLink" href="/">← Back to the key checker</Link>
    </>
  );
}

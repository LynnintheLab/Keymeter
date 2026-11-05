import Link from 'next/link';
import { env } from 'cloudflare:workers';
import { requireChatGPTUser } from '@/app/chatgpt-auth';
import { headers } from 'next/headers';
import { gatewayAuthenticated, sellerAccess, sellerOwner } from '@/lib/seller-auth';
import BillingSetup from './billing-setup';
import { LockBilling, PasswordGate } from './password-gate';

export const dynamic = 'force-dynamic';

export default async function SellerPage() {
  const user = await requireChatGPTUser('/seller');
  const isOwner = sellerOwner(user, env);
  let access: 'setup' | 'locked' | 'unlocked' | 'unavailable' = 'locked';
  if (isOwner) {
    try { access = await sellerAccess(env, user, (await headers()).get('cookie') || ''); }
    catch { access = 'unavailable'; }
  }
  return (
    <>
      <header>
        <div className="wrap bar">
          <Link className="brand" href="/" aria-label="Keymeter home"><img alt="" src="/mark.svg" width="34" height="34" />Keymeter</Link>
          <span className="provider">Seller setup</span>
        </div>
      </header>
      <main className="wrap seller">
        {isOwner ? access === 'unlocked' ? <>
          {!gatewayAuthenticated(env) && <LockBilling />}
          <BillingSetup standalone={gatewayAuthenticated(env)} />
        </> : access === 'unavailable' ? <p className="error" role="alert">Owner sign-in is temporarily unavailable. Please try again shortly.</p> : <PasswordGate setup={access === 'setup'} /> : (
          <section className="sellerIntro">
            <span className="smallCap">Seller access</span>
            <h1>This setup belongs to the site owner.</h1>
            <p className="intro">Sign in with the owner’s ChatGPT account to manage the RunningHub billing connection.</p>
            <Link className="textLink" href="/">Return to the key checker</Link>
          </section>
        )}
      </main>
    </>
  );
}

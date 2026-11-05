import Checker from './checker';
import { env } from 'cloudflare:workers';
import { readPricing } from '@/lib/pricing';
import type { PricePackage } from '@/lib/pricing';

export const dynamic = 'force-dynamic';
export default async function Page() {
  let initialPackages: PricePackage[] | null = null;
  try { initialPackages = (await readPricing(env.DB)).packages; } catch { /* The checker remains available during a pricing outage. */ }
  return <div className="keyApp">
    <header className="keyHeader"><div className="wrap bar"><a className="brand" href="/" aria-label="Keymeter home"><img alt="" src="/mark.svg" width="32" height="32" />Keymeter</a><span className="keyHeaderLabel">Enterprise-Shared</span></div></header>
    <main className="wrap keyMain">
      <Checker initialPackages={initialPackages} />
      <details className="keyHelp" id="help"><summary>Need help?</summary><div><p>Use the full Enterprise-Shared API key from your seller.</p><p>The balance belongs to your key. “No limit reported” means RunningHub didn’t return a spending cap.</p><p>If checking fails, retry shortly or contact your seller.</p></div></details>
    </main>
    <footer className="keyFooter"><div className="wrap bar"><span>Keymeter</span><nav aria-label="Footer"><a href="/seller">Seller sign in</a><a href="https://www.runninghub.ai/enterprise-api/sharedApi" target="_blank" rel="noreferrer">RunningHub ↗</a></nav></div></footer>
  </div>;
}

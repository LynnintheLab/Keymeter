import { env } from 'cloudflare:workers';
import { readPricing } from '@/lib/pricing';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff' };
export async function GET() {
  try { return Response.json(await readPricing(env.DB), { headers }); }
  catch { return Response.json({ error: 'Prices are temporarily unavailable. Contact us for current prices.' }, { status: 503, headers }); }
}

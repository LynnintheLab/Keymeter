import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { PricingError, readPricing, savePricing } from '@/lib/pricing';
import { readLimited } from '@/lib/quota';
import { limitRequest, RequestLimitError } from '@/lib/request-limit';
import { SellerAuthError, sellerAccess, sellerOwner, sellerSameOrigin } from '@/lib/seller-auth';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store, max-age=0', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
async function authorize(request: Request) {
  if (!sellerSameOrigin(request)) throw new SellerAuthError(403, 'Open billing setup on this site to continue.');
  const user = await getChatGPTUser();
  if (!sellerOwner(user, env)) throw new SellerAuthError(403, 'Only the site owner can edit pricing.');
  if (await sellerAccess(env, user, request.headers.get('cookie') || '') !== 'unlocked')
    throw new SellerAuthError(401, 'Unlock billing to edit pricing.');
  await limitRequest(request, env.DB, 'seller', user.userId);
}
function fail(error: unknown) {
  const known = error instanceof SellerAuthError || error instanceof RequestLimitError || error instanceof PricingError;
  return Response.json({ error: known ? error.message : 'Pricing is temporarily unavailable. Try again shortly.' }, {
    status: known ? error.status : 503,
    headers: { ...headers, ...(error instanceof RequestLimitError || error instanceof SellerAuthError ? error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {} : {}) },
  });
}
export async function GET(request: Request) {
  try { await authorize(request); return Response.json(await readPricing(env.DB), { headers }); }
  catch (error) { return fail(error); }
}
export async function PUT(request: Request) {
  try {
    await authorize(request);
    if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json')
      throw new PricingError(415, 'Expected a JSON request.');
    let input;
    try { input = JSON.parse(await readLimited(request.body, 6000)); }
    catch { throw new PricingError(400, 'Invalid pricing update.'); }
    return Response.json(await savePricing(env.DB, input?.packages), { headers });
  } catch (error) { return fail(error); }
}

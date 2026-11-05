import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { BillingError, addSellerRefreshToken, connectSeller, disconnectSeller, sellerStatus } from '@/lib/billing';
import { readLimited } from '@/lib/quota';
import { limitRequest, RequestLimitError } from '@/lib/request-limit';
import { SellerAuthError, sellerAccess, sellerOwner, sellerSameOrigin } from '@/lib/seller-auth';
export const dynamic = 'force-dynamic';
const headers = {
  'Cache-Control': 'private, no-store, max-age=0',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};
function fail(message: string, status: number, retryAfter?: number) {
  return Response.json({ error: message }, { status, headers: {
    ...headers, ...(retryAfter ? { 'Retry-After': String(retryAfter) } : {}),
  } });
}
async function authorize(request: Request) {
  if (!sellerSameOrigin(request)) throw new SellerAuthError(403, 'Open billing setup on this site to continue.');
  const user = await getChatGPTUser();
  if (!sellerOwner(user, env)) throw new SellerAuthError(403, 'Only the site owner can manage seller billing.');
  if (await sellerAccess(env, user, request.headers.get('cookie') || '') !== 'unlocked')
    throw new SellerAuthError(401, 'Unlock billing with your password to continue.');
  return user;
}
function report(error: unknown) {
  if (error instanceof SellerAuthError) return fail(error.message, error.status, error.retryAfter);
  if (error instanceof RequestLimitError) return fail(error.message, error.status, error.retryAfter);
  return error instanceof BillingError ? fail(error.message, error.status) : fail('Seller billing is unavailable. Please try again.', 503);
}
export async function GET(request: Request) {
  try {
    const user = await authorize(request);
    await limitRequest(request, env.DB, 'seller', user.userId);
    return Response.json(await sellerStatus(env.DB, env.BILLING_ENCRYPTION_KEY), { headers });
  }
  catch (error) { return report(error); }
}
export async function POST(request: Request) {
  try { const user = await authorize(request); await limitRequest(request, env.DB, 'seller', user.userId); }
  catch (error) { return report(error); }
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return fail('Expected a JSON request.', 415);
  let input;
  try { input = JSON.parse(await readLimited(request.body, 18000)); }
  catch { return fail('Invalid seller setup request.', 400); }
  try {
    if (input?.action === 'connect') await connectSeller(env.DB, env.BILLING_ENCRYPTION_KEY, input.sessionToken, input.teamId, undefined, input.refreshToken);
    else if (input?.action === 'add-refresh') await addSellerRefreshToken(env.DB, env.BILLING_ENCRYPTION_KEY, input.refreshToken);
    else return fail('Choose a supported seller setup action.', 400);
    return Response.json({ ok: true }, { headers });
  } catch (error) { return report(error); }
}
export async function DELETE(request: Request) {
  try {
    const user = await authorize(request);
    await limitRequest(request, env.DB, 'seller', user.userId);
    await disconnectSeller(env.DB);
    return Response.json({ ok: true }, { headers });
  } catch (error) { return report(error); }
}

import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { readLimited } from '@/lib/quota';
import {
  SellerAuthError, gatewayAuthenticated, limitSellerPassword, loginSellerPassword,
  logoutSellerPassword, sellerAccess, sellerCookieHeader, sellerOwner, sellerSameOrigin, setupSellerPassword,
} from '@/lib/seller-auth';

export const dynamic = 'force-dynamic';
const headers = {
  'Cache-Control': 'private, no-store, max-age=0',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};
function fail(error: unknown) {
  const known = error instanceof SellerAuthError;
  return Response.json({ error: known ? error.message : 'Owner sign-in is temporarily unavailable.' }, {
    status: known ? error.status : 503,
    headers: { ...headers, ...(known && error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {}) },
  });
}
async function owner(request: Request) {
  if (!sellerSameOrigin(request)) throw new SellerAuthError(403, 'Open billing setup on this site to continue.');
  const user = await getChatGPTUser();
  if (!sellerOwner(user, env)) throw new SellerAuthError(403, 'Only the site owner can manage billing access.');
  return user;
}

export async function GET(request: Request) {
  try {
    const user = await owner(request);
    return Response.json({ state: await sellerAccess(env, user, request.headers.get('cookie') || '') }, { headers });
  } catch (error) { return fail(error); }
}

export async function POST(request: Request) {
  try {
    const user = await owner(request);
    if (gatewayAuthenticated(env)) throw new SellerAuthError(403, 'Use the owner sign-in page for this deployment.');
    if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json')
      throw new SellerAuthError(415, 'Expected a JSON request.');
    let input;
    try { input = JSON.parse(await readLimited(request.body, 4096)); }
    catch { throw new SellerAuthError(400, 'Invalid sign-in request.'); }
    if (input?.action !== 'setup' && input?.action !== 'login') throw new SellerAuthError(400, 'Choose a sign-in action.');
    await limitSellerPassword(request, env, user);
    const token = input.action === 'setup'
      ? await setupSellerPassword(env, user, input.password)
      : await loginSellerPassword(env, user, input.password);
    return Response.json({ ok: true }, { headers: { ...headers, 'Set-Cookie': sellerCookieHeader(token) } });
  } catch (error) { return fail(error); }
}

export async function DELETE(request: Request) {
  try {
    const user = await owner(request);
    await logoutSellerPassword(env, user, request.headers.get('cookie') || '');
    return Response.json({ ok: true }, { headers: { ...headers, 'Set-Cookie': sellerCookieHeader('', true) } });
  } catch (error) { return fail(error); }
}

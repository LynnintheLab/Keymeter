import { randomBytes } from 'node:crypto';
import { requireConfig, emailConfigProblems } from './config.mjs';
import { createFormProtection, verifiedForm, authenticatedSession, checkLogin, cookieHeader, deleteSession, sanitizedHeaders, tokenFromCookie,
  preauthCookieHeader, preauthFromCookie, ownerAccount, validOwnerEmail } from './security.mjs';
import { beginEmailChallenge, emailChallenge, resendEmailChallenge, verifyEmailChallenge, verifyEmailChange, beginOwnerSetup, beginKeyRecovery, verifyOwnerKeyChallenge, EmailCodeError } from './email-auth.mjs';
import { runProviderDiagnostics } from './provider-health.mjs';

const commonHeaders = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' };
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
function mergedCookies(...sources) {
  const cookies = new Map();
  for (const value of sources.flat(Infinity))
    if (typeof value === 'string') cookies.set(value.split('=')[0], value);
  return [...cookies.values()];
}
function respond(response, status, message, headers = {}) {
  const cookies = mergedCookies(response.getHeader('Set-Cookie'), headers['Set-Cookie']);
  response.writeHead(status, { ...commonHeaders, 'Content-Type': 'text/plain; charset=utf-8', ...headers,
    ...(cookies.length ? { 'Set-Cookie': cookies } : {}) }); response.end(message);
}
function page(response, options = {}) {
  const { message = '', status = 200, headers = {}, stage = 'password', bootstrap = false, email = '', newCode = false, protection, setupEmail = '', issuedKey = '', startSetup = false } = options;
  const nonce = randomBytes(16).toString('base64');
  response.writeHead(status, { ...commonHeaders, ...headers,
    'Set-Cookie': mergedCookies(response.getHeader('Set-Cookie'), protection.cookie, headers['Set-Cookie']), 'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'` });
  const isChange = stage === 'change';
  let title, content;
  if (stage === 'unconfigured') {
    title = 'Set your owner email';
    content = '<p>Add ADMIN_EMAIL in your private hosting or preview settings, then restart to begin email verification.</p><p><a href="/">Back to the key checker</a></p>';
  } else if (stage === 'issued') {
    title = 'Save your owner key';
    content = `<p>This key is shown once. Save it in your password manager.</p><label for="owner-key">Your new 64-character key</label><textarea id="owner-key" class="ownerKey" rows="4" readonly spellcheck="false" autocomplete="off">${escape(issuedKey)}</textarea><button id="copy-key" type="button">Copy key</button><p id="copy-status" role="status"></p><p><a href="/seller">I saved my key — continue to billing →</a></p><p class="hint">This browser will stay signed in while you use it. You’ll need your key and an email code again after signing out or 90 days of inactivity.</p>`;
  } else if (stage === 'forgot') {
    title = 'Forgot your owner key?';
    content = `<p>Verify your owner email to create a replacement key.</p><form action="/forgot-key" method="post"><label for="email">Owner email</label><input id="email" name="email" type="email" autocomplete="username" maxlength="254" required><button type="submit">Send recovery code</button></form><p><a href="/login">Back to sign in</a></p>`;
  } else if (stage === 'settings') {
    title = 'Owner email';
    content = `<p class="account">${escape(email)}</p><form action="/owner/email/start" method="post"><label for="newEmail">New owner email</label><input id="newEmail" name="email" type="email" autocomplete="email" maxlength="254" required><label for="password">Current owner key</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="1024" required><button type="submit">Change email</button></form><p class="hint">Verify a code sent to your current email, then another sent to the new address. Other signed-in browsers will be signed out.</p><p><a href="/seller">Back to billing</a></p><form action="/logout" method="post"><button class="secondary" type="submit">Sign out</button></form>`;
  } else if (stage === 'code' || stage === 'recover' || isChange) {
    title = isChange ? (newCode ? 'Verify the new email' : 'Verify your current email') : 'Check your email';
    const base = isChange ? '/owner/email' : stage === 'recover' ? '/forgot-key' : '/login';
    content = `<p>${stage === 'recover' || bootstrap ? 'If the address matches the owner email, a code will arrive. Enter it below.' : 'Enter the 6-digit code sent to your email.'}</p><form action="${base}/verify" method="post"><label for="code">Verification code</label><input class="code" id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus><button type="submit">${isChange ? (newCode ? 'Confirm new email' : 'Continue') : stage === 'recover' ? 'Verify & replace key' : 'Verify & sign in'}</button></form><form class="resend" action="${base}/resend" method="post"><button type="submit" class="secondary">Send a new code</button></form><p class="hint">Codes expire after 5 minutes. Wait 60 seconds before resending.</p><p><a href="${isChange ? '/owner/email' : '/login'}">${isChange ? 'Cancel email change' : 'Back to sign in'}</a></p>`;
  } else if (bootstrap && setupEmail) {
    title = 'Set up your owner key';
    content = `<p>Verify your email. Your owner key will appear once after verification.</p><form action="/login" method="post"><label for="email">Owner email</label><input id="email" name="email" type="email" autocomplete="username" maxlength="254" value="${escape(setupEmail)}" readonly required><button type="submit">Send setup code</button></form><p><a href="/">Back to the key checker</a></p>`;
  } else {
    title = bootstrap ? 'Set up owner access' : 'Owner sign in';
    content = `<p>${bootstrap ? 'Choose your owner email. Your configured password and an email code are required.' : 'Enter your owner key, then verify the email code.'}</p><form action="/login" method="post"><label for="email">${bootstrap ? 'Your owner email' : 'Email'}</label><input id="email" name="email" type="email" autocomplete="username" maxlength="254" required><label for="password">Owner key</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="1024" required><label class="remember"><input name="remember" type="checkbox" value="yes" checked>Keep me signed in on this browser</label><p class="hint">Renews while you use it. Expires after 90 days of inactivity. Uncheck on a shared computer.</p><button type="submit">Send sign-in code</button></form><p><a href="/forgot-key">Forgot key?</a></p><p><a href="/">Back to the key checker</a></p>`;
  }
  content = content.replace(/(<form\b[^>]*method="post"[^>]*>)/g, `$1<input type="hidden" name="csrf" value="${escape(protection.token)}">`);
  const script = stage === 'issued' ? `<script nonce="${nonce}">const key=document.getElementById('owner-key');document.getElementById('copy-key').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(key.value);document.getElementById('copy-status').textContent='Copied. Save it somewhere private.'}catch{key.focus();key.select();document.getElementById('copy-status').textContent='Select and copy the key above.'}});window.addEventListener('pagehide',()=>{key.value=''})</script>` :
    startSetup ? `<script nonce="${nonce}">document.querySelector('form[action="/login"]').requestSubmit()</script>` : '';
  response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Keymeter</title><style nonce="${nonce}">
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { font: 15px system-ui; background: #000; color: #f5f5f5; margin: 0; min-height: 100vh; }
    main { max-width: 460px; margin: 9vh auto; padding: 30px; background: #0b0b0b; border: 1px solid #282828; border-radius: 12px; }
    h1 { font-size: 1.8rem; letter-spacing: -.035em; margin: 16px 0; }
    label { display: block; margin: 20px 0 8px; font-weight: 550; }
    input, button, textarea { width: 100%; font: inherit; padding: 13px; border: 1px solid #656565; border-radius: 8px; }
    input, textarea { background: #111; color: #f5f5f5; }
    input:focus-visible, button:focus-visible, textarea:focus-visible, a:focus-visible { outline: 2px solid #fafafa; outline-offset: 3px; }
    button { background: #fafafa; color: #080808; border-color: #fafafa; margin-top: 24px; cursor: pointer; font-weight: 650; }
    button:hover { background: #e5e5e5; border-color: #e5e5e5; }
    p { line-height: 1.6; color: #a3a3a3; }
    a { color: #fafafa; text-underline-offset: 3px; }
    a:hover { color: #c5c5c5; }
    .brand { font-size: .85rem; letter-spacing: .03em; color: #c5c5c5; }
    .error { color: #f5f5f5; background: #171717; border: 1px solid #3d3d3d; border-radius: 8px; padding: 10px 12px; }
    .hint { font-size: .82rem; }
    .remember { display: flex; gap: 9px; align-items: center; font-size: .83rem; color: #c5c5c5; font-weight: 400; }
    .remember input { width: 16px; height: 16px; padding: 0; accent-color: #fafafa; }
    .code { font: 1.4rem ui-monospace, monospace; letter-spacing: .3em; }
    .secondary { background: #111; color: #f5f5f5; border-color: #656565; margin-top: 12px; font-weight: 450; }
    .secondary:hover { background: #1a1a1a; border-color: #8a8a8a; }
    .ownerKey { font: 1rem ui-monospace, monospace; line-height: 1.6; resize: none; overflow-wrap: anywhere; word-break: break-all; }
    .account { overflow-wrap: anywhere; }
    .resend { margin: 0; }
    @media (max-width: 520px) {
      main { margin: 24px 16px; padding: clamp(18px, 5vw, 24px); }
      h1 { font-size: 1.65rem; }
      input:not([type="checkbox"]):not(.code) { font-size: 1rem; }
      .remember { min-height: 44px; }
      .remember input { flex: none; }
    }
  </style><main><p class="brand">Keymeter · Owner access</p><h1>${escape(title)}</h1>${message ? `<p class="error" role="alert">${escape(message)}</p>` : ''}${content}</main>${script}</html>`);
}
async function formBody(request) {
  if (!request.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) throw new Error();
  const chunks = []; let length = 0;
  for await (const chunk of request) { length += chunk.length; if (length > 8192) throw new Error(); chunks.push(chunk); }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}
export function createGatewayHandler(renderApp, { emailTransport = fetch, connectionProbe = runProviderDiagnostics } = {}) {
  const appOrigin = new URL(requireConfig().APP_URL).origin;
  let diagnosticsAvailableAt = 0;
  const redirect = (response, path, cookies) => respond(response, 303, '', { Location: appOrigin + path, ...(cookies ? { 'Set-Cookie': cookies } : {}) });
  return async (request, response) => {
    try {
      const requestUrl = new URL(request.url, appOrigin);
      const pathname = requestUrl.pathname;
      const authToken = tokenFromCookie(request.headers.cookie), pending = preauthFromCookie(request.headers.cookie);
      const render = (options = {}) => page(response, { ...options, protection: createFormProtection(request.headers) });
      const codeError = (error, stage = 'password') => {
        const known = error instanceof EmailCodeError;
        return render({ message: known ? error.message : 'Owner sign-in is temporarily unavailable. Try again shortly.', status: known ? error.status : 503, stage,
          headers: known && error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {} });
      };
      let form;
      const formRoute = ['/login', '/login/verify', '/login/resend', '/logout', '/owner/email/start', '/owner/email/verify', '/owner/email/resend', '/forgot-key', '/forgot-key/verify', '/forgot-key/resend'].includes(pathname);
      if (formRoute && request.method === 'POST') {
        try { form = await formBody(request); }
        catch { return render({ message: 'The form could not be read. Please try again.', status: 400 }); }
        if (form.getAll('csrf').length !== 1 || !verifiedForm(request.headers, form.get('csrf'))) {
          return render({ message: 'This form expired or could not be verified. Please try signing in again. Allow cookies for this site if it happens again.', status: 403 });
        }
      }
      const session = await authenticatedSession(authToken);
      const owner = session?.owner ?? null;
      if (session?.cookieTtl) response.setHeader('Set-Cookie', cookieHeader(authToken, false, session.cookieTtl));
      if (pathname === '/login' && request.method === 'GET') {
        if (owner) return redirect(response, '/seller');
        const bootstrap = !await ownerAccount(), config = requireConfig();
        if (bootstrap && !config.ADMIN_EMAIL && !config.ADMIN_PASSWORD_HASH) return render({ stage: 'unconfigured' });
        const startSetup = bootstrap && !!config.ADMIN_EMAIL && !emailConfigProblems().length && new URL(request.url, appOrigin).searchParams.get('start') === 'setup';
        if (startSetup && (await emailChallenge(pending, 'key'))?.purpose === 'setup') return redirect(response, '/login/verify');
        // This explicit setup link submits the regular signed POST in the user's
        // browser, so the emailed code remains bound to that browser's cookie.
        return render({ bootstrap, setupEmail: config.ADMIN_EMAIL || '', startSetup });
      }
      if (pathname === '/login' && request.method === 'POST') {
        if (!await ownerAccount() && requireConfig().ADMIN_EMAIL) {
          if (emailConfigProblems().length) return render({ bootstrap: true, setupEmail: requireConfig().ADMIN_EMAIL, status: 503, message: 'Email delivery needs setup before your owner key can be issued.' });
          let challenge;
          try { challenge = await beginOwnerSetup(form.get('email') || '', pending, emailTransport); } catch { /* Uniform public setup response. */ }
          return redirect(response, '/login/verify', preauthCookieHeader(challenge || randomBytes(32).toString('base64url')));
        }
        const result = await checkLogin(form.get('email') || '', form.get('password') || '', request.socket.remoteAddress);
        if (result.limited) return render({ message: `Sign-in is busy. Try again in ${result.retryAfter} seconds.`, status: 429, headers: { 'Retry-After': String(result.retryAfter) } });
        if (!result.ok) return render({ message: 'Email or owner key is incorrect.', status: 401 });
        try {
          const challenge = await beginEmailChallenge({ owner_email: result.email, owner_version: result.ownerVersion, purpose: 'login' }, pending, form.get('remember') === 'yes', emailTransport);
          return redirect(response, '/login/verify', preauthCookieHeader(challenge));
        } catch (error) { return codeError(error); }
      }
      if (pathname === '/login/verify' && request.method === 'GET') {
        return /^[A-Za-z0-9_-]{43}$/.test(pending) ? render({ stage: 'code', bootstrap: !await ownerAccount() }) : redirect(response, '/login', preauthCookieHeader('', true));
      }
      if (pathname === '/login/verify' && request.method === 'POST') {
        try {
          const keyProof = await emailChallenge(pending, 'key');
          if (keyProof?.purpose === 'setup') {
            const issued = await verifyOwnerKeyChallenge(pending, form.get('code'), 'setup');
            return render({ stage: 'issued', issuedKey: issued.key, headers: { 'Set-Cookie': [cookieHeader(issued.token, false, issued.ttl), preauthCookieHeader('', true)] } });
          }
          const session = await verifyEmailChallenge(pending, form.get('code'));
          return redirect(response, '/seller', [cookieHeader(session.token, false, session.ttl), preauthCookieHeader('', true)]);
        } catch (error) { return codeError(error, 'code'); }
      }
      if (pathname === '/login/resend' && request.method === 'POST') {
        try {
          const keyProof = await emailChallenge(pending, 'key');
          return redirect(response, '/login/verify', preauthCookieHeader(await resendEmailChallenge(pending, keyProof?.purpose === 'setup' ? 'key' : 'login', emailTransport)));
        }
        catch (error) { return codeError(error, 'code'); }
      }
      if (pathname === '/forgot-key' && request.method === 'GET') return render({ stage: 'forgot' });
      if (pathname === '/forgot-key' && request.method === 'POST') {
        if (emailConfigProblems().length) return render({ stage: 'forgot', status: 503, message: 'Email recovery is unavailable until email delivery is configured.' });
        let challenge;
        try { challenge = await beginKeyRecovery(form.get('email') || '', pending, emailTransport); } catch { /* Do not disclose whether an email is registered. */ }
        return redirect(response, '/forgot-key/verify', preauthCookieHeader(challenge || randomBytes(32).toString('base64url')));
      }
      if (pathname === '/forgot-key/verify' && request.method === 'GET') return render({ stage: 'recover' });
      if (pathname === '/forgot-key/verify' && request.method === 'POST') {
        try {
          const issued = await verifyOwnerKeyChallenge(pending, form.get('code'), 'recover');
          return render({ stage: 'issued', issuedKey: issued.key, headers: { 'Set-Cookie': [cookieHeader(issued.token, false, issued.ttl), preauthCookieHeader('', true)] } });
        } catch (error) { return codeError(error, 'recover'); }
      }
      if (pathname === '/forgot-key/resend' && request.method === 'POST') {
        // The response is identical for a real and a dummy recovery challenge.
        let challenge;
        try {
          const proof = await emailChallenge(pending, 'key');
          if (proof?.purpose === 'recover') challenge = await resendEmailChallenge(pending, 'key', emailTransport);
        } catch { /* Public recovery keeps account existence private. */ }
        return redirect(response, '/forgot-key/verify', preauthCookieHeader(challenge || pending || randomBytes(32).toString('base64url')));
      }
      if (pathname === '/logout') {
        if (request.method !== 'POST') return respond(response, 405, 'Use the sign-out form.', { Allow: 'POST' });
        await deleteSession(authToken);
        return redirect(response, '/login', [cookieHeader('', true), preauthCookieHeader('', true)]);
      }
      if (pathname === '/api/seller/diagnostics') {
        if (!owner) return respond(response, 403, 'Seller sign-in is required.');
        if (request.method !== 'POST') return respond(response, 405, 'Use the connection test button.', { Allow: 'POST' });
        if (request.headers.origin !== appOrigin ||
            (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin'))
          return respond(response, 403, 'Run the connection test from this site.');
        if (requestUrl.search || request.headers['transfer-encoding'] ||
            (request.headers['content-length'] && request.headers['content-length'] !== '0')) {
          request.resume();
          return respond(response, 400, 'The connection test does not accept inputs.');
        }
        const now = Date.now();
        if (now < diagnosticsAvailableAt) return respond(response, 429, 'Wait before testing the connection again.',
          { 'Retry-After': String(Math.ceil((diagnosticsAvailableAt - now) / 1000)) });
        diagnosticsAvailableAt = now + 30_000;
        return respond(response, 200, JSON.stringify(await connectionProbe()), { 'Content-Type': 'application/json; charset=utf-8' });
      }
      if (pathname === '/owner/email' || pathname.startsWith('/owner/email/')) {
        if (!owner) return redirect(response, '/login');
        if (pathname === '/owner/email' && request.method === 'GET') return render({ stage: 'settings', email: owner.email });
        if (pathname === '/owner/email/start' && request.method === 'POST') {
          const email = (form.get('email') || '').trim().toLowerCase();
          if (!validOwnerEmail(email) || email === owner.email) return render({ stage: 'settings', email: owner.email, message: 'Enter a different valid email address.', status: 400 });
          const result = await checkLogin(owner.email, form.get('password') || '', request.socket.remoteAddress);
          if (result.limited) return render({ stage: 'settings', email: owner.email, message: 'Too many key attempts. Try again shortly.', status: 429, headers: { 'Retry-After': String(result.retryAfter) } });
          if (!result.ok) return render({ stage: 'settings', email: owner.email, message: 'The owner key is incorrect.', status: 401 });
          try {
            const challenge = await beginEmailChallenge({ owner_email: result.email, owner_version: result.ownerVersion, purpose: 'change-old', new_email: email }, pending, false, emailTransport);
            return redirect(response, '/owner/email/verify', preauthCookieHeader(challenge));
          } catch (error) { return codeError(error, 'settings'); }
        }
        if (pathname === '/owner/email/verify' && request.method === 'GET') {
          const challenge = await emailChallenge(pending, 'change');
          return challenge ? render({ stage: 'change', newCode: challenge.purpose === 'change-new' }) : redirect(response, '/owner/email', preauthCookieHeader('', true));
        }
        if (pathname === '/owner/email/verify' && request.method === 'POST') {
          try {
            const result = await verifyEmailChange(pending, form.get('code'), emailTransport);
            if (result.challenge) return redirect(response, '/owner/email/verify', preauthCookieHeader(result.challenge));
            return redirect(response, '/owner/email', [cookieHeader(result.token, false, result.ttl), preauthCookieHeader('', true)]);
          } catch (error) { return codeError(error, 'change'); }
        }
        if (pathname === '/owner/email/resend' && request.method === 'POST') {
          try { return redirect(response, '/owner/email/verify', preauthCookieHeader(await resendEmailChallenge(pending, 'change', emailTransport))); }
          catch (error) { return codeError(error, 'change'); }
        }
        return respond(response, 404, 'Not found.');
      }
      if ((pathname === '/seller' || pathname.startsWith('/seller/')) && !owner) return redirect(response, '/login');
      if ((pathname === '/api/seller' || pathname.startsWith('/api/seller/')) && !owner) return respond(response, 403, 'Seller sign-in is required.');
      request.headers = sanitizedHeaders(request.headers, request.socket.remoteAddress, owner);
      const distinctHeaders = Object.entries(request.headers).map(([name, value]) => [name, [value].flat()]);
      request.headersDistinct = Object.fromEntries(distinctHeaders);
      request.rawHeaders = distinctHeaders.flatMap(([name, values]) => values.flatMap(value => [name, value]));
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'no-referrer');
      await renderApp(request, response);
    } catch {
      if (!response.headersSent) respond(response, 503, 'Seller access is temporarily unavailable. Please try again.'); else response.destroy();
    }
  };
}

import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { getPool, lock, transaction } from './database.mjs';
import { requireConfig, emailConfigProblems } from './config.mjs';
import { createSession, REMEMBER_TTL, SESSION_TTL, ownerAccount, validOwnerEmail, generateOwnerKey, passwordHash } from './security.mjs';

export const CODE_TTL = 5 * 60;
export class EmailCodeError extends Error {
  constructor(status, message, retryAfter) { super(message); this.status = status; this.retryAfter = retryAfter; }
}
const invalid = () => new EmailCodeError(401, 'The code is incorrect or expired. Sign in again if needed.');
const validToken = token => typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
function keyed(context, value) {
  const config = requireConfig();
  return createHmac('sha256', config.SESSION_SECRET).update(`keymeter:email-login:v2\0${context}\0`)
    .update(config.ADMIN_PASSWORD_HASH || '').update('\0').update(value).digest('hex');
}
function tokenHash(token) { return keyed('challenge', token); }
function codeHash(token, code, proof) { return keyed('code', [token, proof.owner_email, proof.owner_version, proof.purpose, proof.new_email || '', code].join('\0')); }
function limited(reset, now) { return new EmailCodeError(429, 'Wait before requesting another email code.', Math.max(1, Math.ceil((reset - now) / 1000))); }
async function mailBudget(connection, now, purpose) {
  // Anonymous recovery/setup requests cannot exhaust password-verified logins'
  // separate delivery allowance, even when the owner's address is known.
  const scope = ['setup', 'recover'].includes(purpose) ? 'public-key-recovery' : 'verified-owner';
  for (const [duration, maximum] of [[60_000, 3], [3_600_000, 10]]) {
    const window = Math.floor(now / duration), reset = (window + 1) * duration;
    const bucket = keyed('mail-budget', scope + '\0' + duration + '\0' + window);
    const [rows] = await connection.execute('SELECT request_count FROM request_limits WHERE bucket_hash = ?', [bucket]);
    if (Number(rows[0]?.request_count || 0) >= maximum) throw limited(reset, now);
    await connection.execute('INSERT INTO request_limits (bucket_hash, reset_at, request_count) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE request_count = request_count + 1', [bucket, reset]);
  }
}
async function readEnvelope(response) {
  if (!response.body) throw new Error();
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > 16_384) throw new Error(); chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}
export async function sendLoginCode(code, email, transport = fetch) {
  const config = requireConfig();
  if (emailConfigProblems(config).length) throw new EmailCodeError(503, 'Owner email delivery is not configured. Add the email settings and restart.');
  if (!validOwnerEmail(email)) throw new EmailCodeError(400, 'Enter a valid owner email.');
  try {
    const response = await transport('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: 'Bearer ' + config.RESEND_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ from: config.AUTH_EMAIL_FROM, to: [email], subject: 'Your Keymeter verification code',
        text: `Your Keymeter verification code is ${code}.\n\nIt expires in 5 minutes and can be used once. If you did not request it, ignore this email. Never share this code.` }),
      signal: AbortSignal.timeout(10_000), redirect: 'error', cache: 'no-store',
    });
    if (!response.ok) throw new Error(); const envelope = await readEnvelope(response);
    if (!envelope || typeof envelope.id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(envelope.id)) throw new Error();
  } catch { throw new EmailCodeError(503, 'The verification email could not be sent. Try again shortly.'); }
}
function targetOf(proof) { return proof.purpose === 'change-new' ? proof.new_email : proof.owner_email; }
async function matchesOwner(proof, connection = getPool()) {
  const current = await ownerAccount(connection);
  if (proof.owner_version === 'bootstrap') {
    if (proof.purpose === 'setup') {
      const pinned = requireConfig().ADMIN_EMAIL?.trim().toLowerCase();
      return !current && validOwnerEmail(pinned) && pinned === proof.owner_email;
    }
    return !current;
  }
  return current && current.version === proof.owner_version && current.email === proof.owner_email;
}
export async function emailChallenge(token, purpose = 'login', now = Date.now()) {
  if (!validToken(token)) return null;
  const [rows] = await getPool().execute('SELECT * FROM owner_email_challenges WHERE token_hash = ? AND delivered = 1 AND attempts < 5 AND expires_at > ?', [tokenHash(token), now]);
  const row = rows[0];
  const allowedPurpose = purposeMatches(row?.purpose, purpose);
  return row && allowedPurpose && await matchesOwner(row) ? row : null;
}
function purposeMatches(actual, expected) {
  if (expected === 'change') return ['change-old', 'change-new'].includes(actual);
  if (expected === 'key') return ['setup', 'recover'].includes(actual);
  return ['login', 'setup', 'recover', 'change-old', 'change-new'].includes(expected) && actual === expected;
}
// Call only after checking the owner password, for a fixed configured bootstrap
// email, for the current verified owner's recovery, or for an email-change chain.
export async function beginEmailChallenge(proof, previousToken = '', remember = false, transport = fetch, now = Date.now()) {
  if (emailConfigProblems(requireConfig()).length) throw new EmailCodeError(503, 'Owner email delivery is not configured. Add the email settings and restart.');
  if (!validOwnerEmail(proof.owner_email) || !['login', 'setup', 'recover', 'change-old', 'change-new'].includes(proof.purpose) ||
      (proof.purpose.startsWith('change-') && (!validOwnerEmail(proof.new_email) || proof.owner_version === 'bootstrap'))) throw invalid();
  const token = randomBytes(32).toString('base64url'), code = randomInt(0, 1_000_000).toString().padStart(6, '0'), hash = tokenHash(token);
  await transaction(async connection => {
    await lock(connection, 'owner-email-login');
    if (!await matchesOwner(proof, connection)) throw invalid();
    await connection.execute('DELETE FROM owner_email_challenges WHERE expires_at <= ?', [now]);
    if (validToken(previousToken)) {
      const [previous] = await connection.execute('SELECT sent_at FROM owner_email_challenges WHERE token_hash = ?', [tokenHash(previousToken)]);
      if (previous[0] && Number(previous[0].sent_at) + 60_000 > now) throw limited(Number(previous[0].sent_at) + 60_000, now);
    }
    await mailBudget(connection, now, proof.purpose);
    if (validToken(previousToken)) await connection.execute('DELETE FROM owner_email_challenges WHERE token_hash = ?', [tokenHash(previousToken)]);
    await connection.execute('INSERT INTO owner_email_challenges (token_hash, owner_email, owner_version, purpose, new_email, code_hash, expires_at, attempts, delivered, remember_browser, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)',
      [hash, proof.owner_email, proof.owner_version, proof.purpose, proof.new_email || null, codeHash(token, code, proof), now + CODE_TTL * 1000, remember ? 1 : 0, now]);
  });
  try {
    await sendLoginCode(code, targetOf(proof), transport);
    const [saved] = await getPool().execute('UPDATE owner_email_challenges SET delivered = 1 WHERE token_hash = ? AND delivered = 0', [hash]);
    if (saved.affectedRows !== 1) throw new Error(); return token;
  } catch (error) {
    await getPool().execute('DELETE FROM owner_email_challenges WHERE token_hash = ?', [hash]);
    if (error instanceof EmailCodeError) throw error; throw new EmailCodeError(503, 'The verification email could not be saved. Sign in again.');
  }
}
export async function resendEmailChallenge(token, purpose = 'login', transport = fetch, now = Date.now()) {
  const current = await emailChallenge(token, purpose, now); if (!current) throw invalid();
  return beginEmailChallenge(current, token, !!current.remember_browser, transport, now);
}
async function consume(connection, token, code, purpose, now) {
  const hash = tokenHash(token);
  const [rows] = await connection.execute('SELECT * FROM owner_email_challenges WHERE token_hash = ? FOR UPDATE', [hash]);
  const row = rows[0];
  const allowedPurpose = purposeMatches(row?.purpose, purpose);
  if (!row || !allowedPurpose || row.delivered !== 1 || Number(row.expires_at) <= now || row.attempts >= 5 || !await matchesOwner(row, connection)) return null;
  const valid = typeof code === 'string' && /^\d{6}$/.test(code) && timingSafeEqual(Buffer.from(row.code_hash, 'hex'), Buffer.from(codeHash(token, code, row), 'hex'));
  if (!valid) { await connection.execute('UPDATE owner_email_challenges SET attempts = attempts + 1 WHERE token_hash = ?', [hash]); return null; }
  await connection.execute('DELETE FROM owner_email_challenges WHERE token_hash = ?', [hash]); return row;
}
export async function verifyEmailChallenge(token, code, now = Date.now()) {
  if (!validToken(token)) throw invalid();
  const result = await transaction(async connection => {
    await lock(connection, 'owner-email-login');
    const row = await consume(connection, token, code, 'login', now); if (!row) return null;
    if (row.owner_version === 'bootstrap')
      await connection.execute('INSERT INTO owner_account (id, email, version) VALUES (1, ?, ?)', [row.owner_email, randomBytes(16).toString('hex')]);
    const ttl = row.remember_browser ? REMEMBER_TTL : SESSION_TTL;
    return { token: await createSession(ttl, now, connection), ttl };
  });
  if (!result) throw invalid(); return result;
}
export async function verifyEmailChange(token, code, transport = fetch, now = Date.now()) {
  if (!validToken(token)) throw invalid();
  const result = await transaction(async connection => {
    await lock(connection, 'owner-email-login');
    const row = await consume(connection, token, code, 'change', now); if (!row) return null;
    if (row.purpose === 'change-old') return { proof: { ...row, purpose: 'change-new' } };
    const [changed] = await connection.execute('UPDATE owner_account SET email = ?, version = ? WHERE id = 1 AND version = ?', [row.new_email, randomBytes(16).toString('hex'), row.owner_version]);
    if (changed.affectedRows !== 1) throw invalid();
    await connection.execute('DELETE FROM auth_sessions');
    await connection.execute('DELETE FROM owner_email_challenges');
    return { token: await createSession(SESSION_TTL, now, connection), ttl: SESSION_TTL };
  });
  if (!result) throw invalid();
  if (result.proof) return { challenge: await beginEmailChallenge(result.proof, '', false, transport, now) };
  return result;
}


// These initiation results are deliberately indistinguishable to the caller's
// UI. Only eligible requests produce a usable database-backed challenge.
export async function beginOwnerSetup(email, previousToken = '', transport = fetch, now = Date.now()) {
  const config = requireConfig();
  const pinned = config.ADMIN_EMAIL?.trim().toLowerCase();
  const supplied = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!validOwnerEmail(pinned) || supplied !== pinned || await ownerAccount()) return null;
  return beginEmailChallenge({ owner_email: pinned, owner_version: 'bootstrap', purpose: 'setup' }, previousToken, false, transport, now);
}
export async function beginKeyRecovery(email, previousToken = '', transport = fetch, now = Date.now()) {
  const supplied = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const current = await ownerAccount();
  if (!current || supplied !== current.email) return null;
  return beginEmailChallenge({ owner_email: current.email, owner_version: current.version, purpose: 'recover' }, previousToken, false, transport, now);
}
export async function verifyOwnerKeyChallenge(token, code, purpose, now = Date.now()) {
  if (!validToken(token) || !['setup', 'recover'].includes(purpose)) throw invalid();
  const result = await transaction(async connection => {
    await lock(connection, 'owner-email-login');
    const row = await consume(connection, token, code, purpose, now);
    if (!row) return null;
    // Generate only after the one-time email proof has passed. The raw key lives
    // only in this result and is never written into a table or secret file.
    const key = generateOwnerKey();
    const encoded = await passwordHash(key);
    const version = randomBytes(16).toString('hex');
    if (purpose === 'setup') {
      await connection.execute('INSERT INTO owner_account (id, email, version, password_hash) VALUES (1, ?, ?, ?)', [row.owner_email, version, encoded]);
    } else {
      const [changed] = await connection.execute('UPDATE owner_account SET password_hash = ?, version = ? WHERE id = 1 AND email = ? AND version = ?', [encoded, version, row.owner_email, row.owner_version]);
      if (changed.affectedRows !== 1) throw invalid();
    }
    await connection.execute('DELETE FROM auth_sessions');
    await connection.execute('DELETE FROM owner_email_challenges');
    const ttl = SESSION_TTL;
    return { key, token: await createSession(ttl, now, connection), ttl };
  });
  if (!result) throw invalid();
  return result;
}

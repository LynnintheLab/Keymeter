import { randomBytes } from 'node:crypto';
import { passwordHash } from './security.mjs';

const arguments_ = process.argv.slice(2);
if (arguments_.some(value => value !== '--legacy-password') || arguments_.length > 1)
  throw new Error('Usage: npm run hostinger:secrets [-- --legacy-password]');

async function hidden(prompt) {
  if (!process.stdin.isTTY) throw new Error('Legacy password setup requires an interactive terminal.');
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    function data(chunk) {
      for (const character of chunk.toString()) {
        if (character === '\u0003') { finish(); reject(new Error('Cancelled.')); return; }
        if (character === '\r' || character === '\n') { finish(); resolve(value); return; }
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else if (character >= ' ') value += character;
      }
    }
    function finish() {
      process.stdin.off('data', data);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
    }
    process.stdin.on('data', data);
  });
}
let legacyHash;
if (arguments_.includes('--legacy-password')) {
  const password = await hidden('Legacy owner password (hidden, at least 20 characters): ');
  const confirmation = await hidden('Confirm legacy owner password (hidden): ');
  if (password.length < 20 || password.length > 1024 || password !== confirmation)
    throw new Error('Passwords must match and contain 20–1024 characters.');
  legacyHash = await passwordHash(password);
}
console.log('\nCopy these server secrets into private Hostinger environment settings. Keep them safe.');
if (legacyHash) console.log('ADMIN_PASSWORD_HASH=' + legacyHash);
console.log('SESSION_SECRET=' + randomBytes(32).toString('base64url'));
console.log('BILLING_ENCRYPTION_KEY=' + randomBytes(32).toString('base64'));
console.log('\nSet ADMIN_EMAIL and the email-delivery settings privately. After email verification, /login shows a new 64-character owner key once.');

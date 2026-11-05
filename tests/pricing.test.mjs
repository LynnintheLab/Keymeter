import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from './worker-fixture.mjs';
import { DEFAULT_PACKAGES, validatePackages, readPricing } from '../lib/pricing.ts';

test('pricing accepts exactly six known denominations and bounded whole-number Ks values', async () => {
  assert.deepEqual(validatePackages([...DEFAULT_PACKAGES].reverse()), DEFAULT_PACKAGES);
  for (const packages of [
    DEFAULT_PACKAGES.slice(0, 5),
    DEFAULT_PACKAGES.map((row, i) => i === 0 ? { ...row, usd: 11 } : row),
    DEFAULT_PACKAGES.map((row, i) => i === 0 ? { ...row, usd: 20 } : row),
    ...[0, -1, 1.5, 1_000_000_001, '62000', null].map(kyat => DEFAULT_PACKAGES.map((row, i) => i === 0 ? { ...row, kyat } : row)),
  ]) assert.throws(() => validatePackages(packages), error => error.status === 400);
  await assert.rejects(readPricing(undefined), error => error.status === 503);
});

test('pricing routes protect edits and publish only persisted validated prices with no failure fallback', async t => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const bundle = await build({
    stdin: { contents: `
      import * as publicPricing from './app/api/pricing/route.ts';
      import * as sellerPricing from './app/api/seller/pricing/route.ts';
      import * as auth from './app/api/seller/auth/route.ts';
      import {setIdentity} from 'fixture-identity';
      export default { async fetch(request) {
        setIdentity(request.headers.get('x-fixture-owner') === 'yes' ? {userId:'synthetic-price-owner',email:'owner@example.test'} : null);
        const path = new URL(request.url).pathname;
        const handler = path === '/api/pricing' ? publicPricing : path === '/api/seller/auth' ? auth : sellerPricing;
        return handler[request.method]?.(request) || new Response('method',{status:405});
      }};`, sourcefile: 'pricing-fixture.ts', resolveDir: root },
    bundle: true, format: 'esm', external: ['node:*', 'cloudflare:workers'], write: false,
    plugins: [{ name: 'verified-owner-fixture', setup(build) {
      build.onResolve({filter: /^(fixture-identity|@\/app\/chatgpt-auth)$/}, () => ({path:'owner',namespace:'fixture'}));
      build.onLoad({filter: /.*/,namespace:'fixture'}, () => ({contents:'let identity=null; export function setIdentity(value){identity=value}; export async function getChatGPTUser(){return identity}'}));
    }}],
  });
  const worker = new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],
    d1Databases:['DB'],bindings:{BILLING_ENCRYPTION_KEY:randomBytes(32).toString('base64'),KEYMETER_OWNER_EMAIL:'owner@example.test'},
    outboundService() { assert.fail('Pricing must never call an upstream provider.'); },
  });
  t.after(() => worker.dispose());
  const db = await worker.getD1Database('DB');
  const directory = new URL('../drizzle/',import.meta.url);
  for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort())
    await db.batch((await readFile(new URL(name,directory),'utf8')).split('--> statement-breakpoint').map(sql => db.prepare(sql)));
  const publicUrl='https://checker.test/api/pricing',privateUrl='https://checker.test/api/seller/pricing',authUrl='https://checker.test/api/seller/auth';
  const ownerHeaders={'x-fixture-owner':'yes',origin:'https://checker.test','content-type':'application/json'};
  const initial=await worker.dispatchFetch(publicUrl);
  assert.equal(initial.status,200);
  assert.match(initial.headers.get('cache-control'),/no-store/);
  assert.deepEqual(await initial.json(),{packages:DEFAULT_PACKAGES,updatedAt:null});
  for (const method of ['GET','PUT']) {
    assert.equal((await worker.dispatchFetch(privateUrl,{method,headers:{origin:'https://checker.test'}})).status,403);
    assert.equal((await worker.dispatchFetch(privateUrl,{method,headers:ownerHeaders})).status,401);
  }
  const setup=await worker.dispatchFetch(authUrl,{method:'POST',headers:ownerHeaders,body:JSON.stringify({action:'setup',password:'synthetic pricing owner passphrase'})});
  assert.equal(setup.status,200);
  const headers={...ownerHeaders,cookie:setup.headers.get('set-cookie').split(';')[0]};
  assert.equal((await worker.dispatchFetch(privateUrl,{headers})).status,200);
  const packages=DEFAULT_PACKAGES.map(row=>({...row,kyat:row.kyat+100}));
  const save=await worker.dispatchFetch(privateUrl,{method:'PUT',headers,body:JSON.stringify({packages})});
  assert.equal(save.status,200);
  const saved=await save.json();
  assert.deepEqual(saved.packages,packages);
  assert.ok(Number.isFinite(Date.parse(saved.updatedAt)));
  assert.deepEqual(await (await worker.dispatchFetch(publicUrl)).json(),saved);
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM app_settings').first()).count,1);
  for (const input of [packages.slice(0,5),packages.map((row,i)=>i===1?{...row,kyat:0}:row),packages.map((row,i)=>i===2?{...row,usd:20}:row)]) {
    const response=await worker.dispatchFetch(privateUrl,{method:'PUT',headers,body:JSON.stringify({packages:input})});
    assert.equal(response.status,400);
    assert.deepEqual(await (await worker.dispatchFetch(publicUrl)).json(),saved);
  }
  assert.equal((await worker.dispatchFetch(privateUrl,{method:'PUT',headers:{...headers,origin:'https://evil.test'},body:JSON.stringify({packages})})).status,403);
  assert.equal((await worker.dispatchFetch(privateUrl,{method:'PUT',headers:{...headers,'content-type':'text/plain'},body:'{}'})).status,415);
  assert.equal((await worker.dispatchFetch(privateUrl,{method:'PUT',headers,body:JSON.stringify({packages,padding:'x'.repeat(7000)})})).status,400);
  await db.prepare('UPDATE app_settings SET value_json = ? WHERE id = ?').bind('corrupt stored configuration','pricing').run();
  const corrupt=await worker.dispatchFetch(publicUrl);
  assert.equal(corrupt.status,503);
  assert.equal((await corrupt.json()).packages,undefined);
  await db.prepare('DROP TABLE app_settings').run();
  const failed=await worker.dispatchFetch(publicUrl);
  assert.equal(failed.status,503);
  assert.deepEqual(await failed.json(),{error:'Prices are temporarily unavailable. Contact us for current prices.'});
});

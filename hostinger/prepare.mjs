import { cp, mkdir, writeFile, readdir } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const output = new URL('dist/', root);
await mkdir(new URL('hostinger/', output), { recursive: true });
await cp(new URL('server.mjs', root), new URL('server.mjs', output));
for (const file of ['config.mjs', 'database.mjs', 'security.mjs', 'gateway.mjs', 'schema.sql', 'email-auth.mjs', 'diagnose-runninghub.mjs', ...(await readdir(new URL('hostinger/', root))).filter(file => /^\d{3}_[a-z_]+\.sql$/.test(file)).sort()])
  await cp(new URL('hostinger/' + file, root), new URL('hostinger/' + file, output));
await writeFile(new URL('hostinger-build.json', output), JSON.stringify({ target: 'hostinger' }));
console.log('Hostinger production output is ready in dist.');

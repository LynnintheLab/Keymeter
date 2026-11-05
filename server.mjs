import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

process.env.NODE_ENV = 'production';
const here = dirname(fileURLToPath(import.meta.url));
const output = existsSync(join(here, 'hostinger-build.json')) ? here : join(here, 'dist');
const marker = JSON.parse(readFileSync(join(output, 'hostinger-build.json'), 'utf8'));
if (marker.target !== 'hostinger') throw new Error('Run npm run build:hostinger before starting this server.');
const hostinger = file => pathToFileURL(join(output, 'hostinger', file)).href;
const { configProblems } = await import(hostinger('config.mjs'));
const { migrateDatabase, closeDatabase } = await import(hostinger('database.mjs'));
const { createGateway } = await import(hostinger('gateway.mjs'));
const problems = configProblems();
let ready = problems.length === 0;
if (!ready) console.error(problems.join('\n'));
if (ready) {
  try { await migrateDatabase(pathToFileURL(join(output, 'hostinger/'))); }
  catch {
    ready = false;
    console.error('Database initialization failed. Check DB settings, permissions and migration history.');
    await closeDatabase();
  }
}
const port = Number(process.env.PORT || 3000);
let internal;
let server;
if (ready) {
  process.env.VINEXT_TRUSTED_HOSTS = new URL(process.env.APP_URL).host;
  const { startProdServer } = await import('vinext/server/prod-server');
  // Only this loopback server can receive the gateway's authenticated identity.
  // It is the compiled production Node handler, with no local Worker emulator.
  ({ server: internal } = await startProdServer({ port: 0, host: '127.0.0.1', outDir: output, silent: true }));
  server = createGateway(internal.address().port);
} else {
  server = createServer((_request, response) => {
    response.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Keymeter setup</title><body style="font:16px system-ui;max-width:560px;margin:15vh auto;padding:24px"><h1>Keymeter setup is incomplete</h1><p>Add the database, owner login, and encryption settings in Hostinger, then restart the app.</p></body></html>');
  });
}
server.listen(port, process.env.KEYMETER_BIND_HOST || '0.0.0.0', () => console.log(`Keymeter ${ready ? 'production app' : 'setup page'} listening on port ${port}`));
server.on('error', () => { console.error('Could not start the HTTP server. Check PORT and restart.'); process.exitCode = 1; });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  server.close(async () => {
    if (internal) await new Promise(resolve => internal.close(resolve));
    await closeDatabase();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
});

import { createServer, Server as HttpServer } from 'node:http';
import { Server as NetServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

async function startRenderer(output) {
  const { startProdServer } = await import('vinext/server/prod-server');
  const options = { port: 0, host: '127.0.0.1', outDir: output, silent: true };
  const publicListen = HttpServer.prototype.listen;
  if (publicListen === NetServer.prototype.listen) return startProdServer(options);

  // LiteSpeed assigns its public socket to the first HTTP listen. Bind only the
  // renderer's private loopback socket here, then restore the gateway's listener.
  HttpServer.prototype.listen = function (port, host, callback) {
    if (port !== options.port || host !== options.host || typeof callback !== 'function') {
      throw new Error('Unexpected private renderer listen arguments.');
    }
    this.address = NetServer.prototype.address;
    return NetServer.prototype.listen.call(this, port, host, callback);
  };
  try {
    return await startProdServer(options);
  } finally {
    HttpServer.prototype.listen = publicListen;
  }
}

async function main() {
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

  let internal;
  let server;
  const shutdown = async () => {
    if (internal) await new Promise(resolve => internal.close(resolve));
    await closeDatabase();
  };
  try {
    if (ready) {
      process.env.VINEXT_TRUSTED_HOSTS = new URL(process.env.APP_URL).host;
      process.env.KEYMETER_GATEWAY_PROOF = randomBytes(32).toString('base64url');
      ({ server: internal } = await startRenderer(output));
      const endpoint = internal.address();
      if (endpoint?.address !== '127.0.0.1') throw new Error('Private renderer did not bind to loopback.');
      server = createGateway(endpoint.port);
    } else {
      server = createServer((_request, response) => {
        response.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        response.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Keymeter setup</title><body style="font:16px system-ui;max-width:560px;margin:15vh auto;padding:24px"><h1>Keymeter setup is incomplete</h1><p>Add the database, owner login, and encryption settings in Hostinger, then restart the app.</p></body></html>');
      });
    }
    const port = Number(process.env.PORT || 3000);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, process.env.KEYMETER_BIND_HOST || '0.0.0.0', () => {
        server.off('error', reject);
        resolve();
      });
    });
    console.log(`Keymeter ${ready ? 'production app' : 'setup page'} listening on port ${port}`);
  } catch (error) {
    await shutdown();
    throw error;
  }

  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    server.close(() => { void shutdown().finally(() => process.exit(0)); });
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

// Keep startup asynchronous without top-level await so Node 24 hosting
// loaders can load this entry with require() as well as with node server.mjs.
void main().catch(error => {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? ` (${error.code})` : '';
  console.error(`Could not start Keymeter${code}. Check the Hostinger build output, entry file, and PORT.`);
  process.exitCode = 1;
});

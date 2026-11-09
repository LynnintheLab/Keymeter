import { createServer, Server as HttpServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

async function startApp(output, port, host, createGatewayHandler) {
  const { startProdServer } = await import('vinext/server/prod-server');
  const publicListen = HttpServer.prototype.listen;

  // Vinext initializes its renderer before calling listen. Wrap its handler
  // before that single listener is exposed to LiteSpeed or directly to Node.
  HttpServer.prototype.listen = function (listenPort, listenHost, callback) {
    HttpServer.prototype.listen = publicListen;
    const [renderApp, ...others] = this.listeners('request');
    if (listenPort !== port || listenHost !== host || typeof callback !== 'function' || !renderApp || others.length) {
      throw new Error('Unexpected Vinext HTTP server configuration.');
    }
    this.off('request', renderApp);
    this.on('request', createGatewayHandler(renderApp));
    return publicListen.call(this, listenPort, listenHost, callback);
  };
  try {
    const { server } = await startProdServer({ port, host, outDir: output, silent: true });
    return server;
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
  const { createGatewayHandler } = await import(hostinger('gateway.mjs'));
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
  const host = process.env.KEYMETER_BIND_HOST || '0.0.0.0';
  let server;
  try {
    if (ready) {
      process.env.VINEXT_TRUSTED_HOSTS = new URL(process.env.APP_URL).host;
      process.env.KEYMETER_GATEWAY_PROOF = randomBytes(32).toString('base64url');
      server = await startApp(output, port, host, createGatewayHandler);
    } else {
      server = createServer((_request, response) => {
        response.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        response.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Keymeter setup</title><body style="font:16px system-ui;max-width:560px;margin:15vh auto;padding:24px"><h1>Keymeter setup is incomplete</h1><p>Add the database, owner login, and encryption settings in Hostinger, then restart the app.</p></body></html>');
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
    }
    console.log(`Keymeter ${ready ? 'production app' : 'setup page'} listening on port ${port}`);
  } catch (error) {
    await closeDatabase();
    throw error;
  }

  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    server.close(() => { void closeDatabase().finally(() => process.exit(0)); });
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

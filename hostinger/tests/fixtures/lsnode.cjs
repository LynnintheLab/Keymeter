const { Server: HttpServer } = require('node:http');
const { Server: NetServer } = require('node:net');
const { EventEmitter } = require('node:events');

// The hosting launcher owns the only listener. Reject attempts to open a private server.
const realListen = NetServer.prototype.listen;
NetServer.prototype.listen = () => { throw new Error('The hosting runtime does not permit extra listeners.'); };
globalThis.LsNode = new EventEmitter();
globalThis.LsNode.listenDone = false;
HttpServer.prototype.listen = function (...args) {
  if (globalThis.LsNode.listenDone) throw new Error('LiteSpeed already assigned its public socket.');
  globalThis.LsNode.listenDone = true;
  return realListen.call(this, { path: process.env.LSNODE_SOCKET }, args.at(-1));
};
HttpServer.prototype.address = () => process.env.LSNODE_SOCKET;
require('../../../dist/server.mjs');

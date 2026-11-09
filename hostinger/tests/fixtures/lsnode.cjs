const { Server } = require('node:http');
const { EventEmitter } = require('node:events');

// LiteSpeed exposes the first HTTP listener through its socket and ignores later listeners.
globalThis.LsNode = new EventEmitter();
globalThis.LsNode.listenDone = false;
Server.prototype.realListen = Server.prototype.listen;
Server.prototype.listen = function (...args) {
  if (globalThis.LsNode.listenDone) return this;
  globalThis.LsNode.listenDone = true;
  return this.realListen({ path: process.env.LSNODE_SOCKET }, args.at(-1));
};
Server.prototype.address = () => process.env.LSNODE_SOCKET;
require('../../../dist/server.mjs');

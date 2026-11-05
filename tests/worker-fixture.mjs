import { Miniflare as WorkerRuntime, convertV4MiniflareOptions } from 'miniflare';

// Miniflare 5 provides the official converter for the established Worker options.
export class Miniflare extends WorkerRuntime {
  constructor(options) {
    super(convertV4MiniflareOptions(options));
  }
}

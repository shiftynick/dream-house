import { createServer as createHttpServer } from 'node:http';
import type { Express } from 'express';
import { createServer } from 'vite';
import assert from 'node:assert/strict';

/** HTTP and websocket traffic stay on this one private ephemeral loopback listener. */
export async function startVerificationServer(host: Express) {
  const server = createHttpServer(host);
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const vite = await createServer({
    server: {
      middlewareMode: true,
      hmr: { server, host: '127.0.0.1', port: address.port, clientPort: address.port },
    },
    appType: 'spa',
  });
  host.use(vite.middlewares);
  return {
    port: address.port,
    async close() {
      // No agent/provider jobs remain at this point. Terminate lingering browser polls.
      server.closeAllConnections();
      await vite.close();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
        server.closeAllConnections();
      });
    },
  };
}

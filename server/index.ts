import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'node:path';
import { createApplication } from './app.ts';

try {
  process.loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
const root = process.cwd();
const directory = process.env.TERRAIN_DATA_DIR
  ? path.resolve(process.env.TERRAIN_DATA_DIR)
  : path.join(root, '.data');
const { app } = await createApplication({ directory });
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(root, 'dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(root, 'dist/index.html')));
} else {
  const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}
const port = Number(process.env.PORT || 5173);
app.listen(port, '127.0.0.1', () =>
  console.log(`Terrain is running locally at http://localhost:${port}`),
);

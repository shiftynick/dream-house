import express from 'express';
import { createServer as createViteServer } from 'vite';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { sceneSchema, messageSchema } from '../shared/model.ts';
import { ProjectStore } from './storage.ts';
import { runAgent } from './agent.ts';
import { ConnectionStore, resolveConnections } from './connections.ts';
import {
  GatewayError,
  normalizeAudioMediaType,
  synthesizeSpeech,
  transcribeAudio,
} from './gateway.ts';

try {
  process.loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
const root = process.cwd();
const directory = path.join(root, '.data');
const store = new ProjectStore(directory);
const connections = new ConnectionStore(directory);
await connections.load();
const gateway = () => resolveConnections(connections.get());
type Usage = { day: string; requests: number; modelCost: number };
let usage: Usage = { day: new Date().toISOString().slice(0, 10), requests: 0, modelCost: 0 };
try {
  usage = JSON.parse(await readFile(path.join(directory, 'usage.json'), 'utf8'));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
let usageQueue = Promise.resolve();
function persistUsage() {
  const snapshot = JSON.stringify(usage);
  usageQueue = usageQueue
    .catch(() => {})
    .then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(path.join(directory, 'usage.json.tmp'), snapshot, { mode: 0o600 });
      await rename(path.join(directory, 'usage.json.tmp'), path.join(directory, 'usage.json'));
    });
  return usageQueue;
}
function resetDay() {
  const day = new Date().toISOString().slice(0, 10);
  if (usage.day !== day) usage = { day, requests: 0, modelCost: 0 };
}
async function chargeRequest() {
  resetDay();
  if (usage.requests >= connections.get().dailyLimit)
    throw new Error(
      'Daily cloud request limit reached. Adjust it in Connections if you want to continue.',
    );
  usage.requests++;
  await persistUsage();
}
const app = express();
app.disable('x-powered-by');
app.use('/api', (req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    try {
      const host = new URL(origin).hostname;
      if (!['localhost', '127.0.0.1', '[::1]'].includes(host))
        return res.status(403).json({ error: 'This API is local to your desktop.' });
    } catch {
      return res.status(403).json({ error: 'Invalid origin.' });
    }
  }
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '8mb' }));
app.get('/api/status', (_req, res) => {
  resetDay();
  const config = gateway();
  res.json({
    gatewayConnected: !!config.key,
    modelConnected: !!config.key,
    voiceConnected: !!config.key,
    keySource: config.keySource,
    model: config.model,
    speechModel: config.speechModel,
    transcriptionModel: config.transcriptionModel,
    speechVoice: config.speechVoice,
    dailyLimit: connections.get().dailyLimit,
    usage,
  });
});
app.put('/api/connections', async (req, res) => {
  await connections.save(req.body);
  res.json({ ok: true });
});
app.get('/api/project', async (_req, res) => {
  res.json(await store.read());
});
app.put('/api/project', async (req, res) => {
  await store.save(req.body);
  res.json({ ok: true });
});
let agentBusy = false;
app.post('/api/agent', async (req, res, next) => {
  const config = gateway();
  if (!config.key)
    return res
      .status(428)
      .json({
        error: 'Add a Vercel AI Gateway key in Connections or AI_GATEWAY_API_KEY in .env to begin.',
      });
  if (agentBusy)
    return res
      .status(409)
      .json({ error: 'A design is already in progress. Please wait for it to finish.' });
  try {
    const input = z
      .object({ scene: sceneSchema, messages: z.array(messageSchema).min(1).max(100) })
      .parse(req.body);
    agentBusy = true;
    await chargeRequest();
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });
    const result = await runAgent({
      key: config.key,
      model: config.model,
      ...input,
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(90000)]),
    });
    if (result.usage.cost) {
      usage.modelCost += result.usage.cost;
      await persistUsage();
    }
    res.json(result);
  } catch (error) {
    next(error);
  } finally {
    agentBusy = false;
  }
});
app.post(
  '/api/transcribe',
  express.raw({
    type: ['audio/*', 'video/webm', 'video/mp4', 'application/octet-stream'],
    limit: '12mb',
  }),
  async (req, res) => {
    const config = gateway();
    if (!config.key)
      return res
        .status(428)
        .json({ error: 'Add a Vercel AI Gateway key in Connections to enable push-to-talk.' });
    if (!Buffer.isBuffer(req.body) || req.body.length < 100)
      return res
        .status(400)
        .json({ error: 'No audio captured. Hold the microphone button while speaking.' });
    const mediaType = normalizeAudioMediaType(req.headers['content-type'] || '');
    await chargeRequest();
    const result = await transcribeAudio({
      key: config.key,
      model: config.transcriptionModel,
      audio: req.body,
      mediaType,
      signal: AbortSignal.timeout(60000),
    });
    res.json({ text: result.text });
  },
);
app.post('/api/speak', async (req, res) => {
  const config = gateway();
  if (!config.key)
    return res
      .status(428)
      .json({ error: 'Add a Vercel AI Gateway key in Connections for cloud speech.' });
  const { text } = z.object({ text: z.string().min(1).max(1500) }).parse(req.body);
  await chargeRequest();
  const result = await synthesizeSpeech({
    key: config.key,
    model: config.speechModel,
    voice: config.speechVoice,
    text,
    signal: AbortSignal.timeout(60000),
  });
  res.type(result.mediaType).send(result.audio);
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API route.' }));
app.use(
  (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const validation = error instanceof z.ZodError;
    res.status(validation ? 400 : error instanceof GatewayError ? 502 : 500).json({
      error: validation
        ? 'The design or settings were invalid. Your saved house was not changed.'
        : error instanceof Error
          ? error.message
          : 'Unexpected local server error.',
    });
  },
);
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

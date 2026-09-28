import express from 'express';
import { createServer as createViteServer } from 'vite';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { sceneSchema, messageSchema } from '../shared/model.ts';
import { ProjectStore } from './storage.ts';
import { runAgent } from './agent.ts';

try {
  process.loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
const root = process.cwd();
const directory = path.join(root, '.data');
const store = new ProjectStore(directory);
const settingsSchema = z.object({
  openrouterKey: z.string().max(500).default(''),
  openaiKey: z.string().max(500).default(''),
  model: z.string().min(1).max(120).default('openai/gpt-4.1-mini'),
  dailyLimit: z.number().int().min(1).max(1000).default(60),
});
let settings = settingsSchema.parse({});
try {
  settings = settingsSchema.parse(
    JSON.parse(await readFile(path.join(directory, 'connections.json'), 'utf8')),
  );
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
const keys = () => ({
  router: settings.openrouterKey || process.env.OPENROUTER_API_KEY || '',
  voice: settings.openaiKey || process.env.OPENAI_API_KEY || '',
  model: process.env.OPENROUTER_MODEL || settings.model,
});
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
  if (usage.requests >= settings.dailyLimit)
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
  res.json({
    modelConnected: !!keys().router,
    voiceConnected: !!keys().voice,
    model: keys().model,
    dailyLimit: settings.dailyLimit,
    usage,
  });
});
app.put('/api/connections', async (req, res) => {
  const input = settingsSchema.partial().parse(req.body);
  settings = settingsSchema.parse({ ...settings, ...input });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, 'connections.json'), JSON.stringify(settings), {
    mode: 0o600,
  });
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
  if (!keys().router)
    return res
      .status(428)
      .json({ error: 'Connect an OpenRouter key in Connections to design with the agent.' });
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
      key: keys().router,
      model: keys().model,
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
  express.raw({ type: ['audio/*', 'video/webm', 'application/octet-stream'], limit: '12mb' }),
  async (req, res) => {
    if (!keys().voice)
      return res
        .status(428)
        .json({ error: 'Add an OpenAI key in Connections to enable push-to-talk.' });
    if (!Buffer.isBuffer(req.body) || req.body.length < 100)
      return res
        .status(400)
        .json({ error: 'No audio captured. Hold the microphone button while speaking.' });
    await chargeRequest();
    const form = new FormData();
    const contentType = req.headers['content-type'] || 'audio/webm';
    form.append(
      'file',
      new Blob([new Uint8Array(req.body)], { type: contentType }),
      contentType.includes('mp4') ? 'speech.mp4' : 'speech.webm',
    );
    form.append('model', 'gpt-4o-mini-transcribe');
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${keys().voice}` },
      body: form,
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok)
      throw new Error(
        `Voice transcription failed (${response.status}). Check the OpenAI key and credits in Connections.`,
      );
    const body = await response.json();
    res.json({ text: body.text });
  },
);
app.post('/api/speak', async (req, res) => {
  if (!keys().voice)
    return res.status(428).json({ error: 'Connect an OpenAI key for cloud speech.' });
  const { text } = z.object({ text: z.string().min(1).max(1500) }).parse(req.body);
  await chargeRequest();
  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${keys().voice}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts',
      voice: 'coral',
      input: text,
      instructions: 'Speak calmly and naturally, like a thoughtful architectural design partner.',
      response_format: 'mp3',
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok)
    throw new Error(
      `Speech playback failed (${response.status}). The written response is still available.`,
    );
  res.type('audio/mpeg').send(Buffer.from(await response.arrayBuffer()));
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API route.' }));
app.use(
  (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const validation = error instanceof z.ZodError;
    res
      .status(validation ? 400 : 500)
      .json({
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

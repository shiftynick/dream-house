/** No-cloud browser harness. This separate entry point never loads .env and never
 * installs production model/audio adapters. All geometry/storage/render paths are real. */
import express from 'express';
import { createServer } from 'vite';
import path from 'node:path';
import { z } from 'zod';
import { createApplication } from '../server/app.ts';
import type { AgentModel, ModelTurn } from '../server/agent.ts';
import { newProject, sceneSchema, type Scene } from '../shared/model.ts';
import { renderRequestSchema } from '../shared/render.ts';

const label = z
  .string()
  .regex(/^[a-z0-9_-]+$/)
  .parse(process.env.SCENARIO_RUN || 'scenarios');
const directory = path.resolve('.data/verification', label);
const port = Number(process.env.SCENARIO_PORT || 5186);
const hostname = process.env.SCENARIO_HOST || '127.0.0.1';
const stepSchema = z.object({
  calls: z.array(z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()) })),
  delayMs: z.number().min(0).max(20_000).default(30),
  fail: z.string().optional(),
});
let steps: z.infer<typeof stepSchema>[] = [];
let transcript = 'Make the selected room cedar.';
let sequence = 0;
const modelClient: AgentModel = {
  async complete(_messages, signal) {
    const step = steps.shift();
    if (!step) throw new Error('No simulated turn queued. This server never calls a model.');
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        steps = [];
        reject(signal?.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', abort);
        resolve();
      }, step.delayMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
    if (step.fail) throw new Error(step.fail);
    return {
      content: null,
      calls: step.calls.map((call) => ({
        id: `simulated-${++sequence}`,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
      usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
      truncated: false,
    } satisfies ModelTurn;
  },
};
// A short valid silent WAV lets the real browser audio-response path run without
// representing synthetic silence as a speech-quality evaluation.
const wav = Buffer.alloc(44 + 16_000);
wav.write('RIFF', 0);
wav.writeUInt32LE(wav.length - 8, 4);
wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16_000, 24);
wav.writeUInt32LE(32_000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(16_000, 40);
const audioFetcher: typeof fetch = async (input) => {
  const url = String(input);
  if (url.endsWith('/v4/ai/transcription-model')) return Response.json({ text: transcript });
  if (url.endsWith('/v4/ai/speech-model'))
    return Response.json({ audio: wav.toString('base64'), usage: { cost: 0 } });
  throw new Error('Unexpected simulated audio endpoint; network access is disabled.');
};
const { app, store, renders } = await createApplication({
  directory,
  env: { AI_GATEWAY_API_KEY: 'simulated-no-cloud' },
  modelClient,
  audioFetcher,
});
const host = express();
// The optional host is for a private remote preview. Only this isolated,
// credential-free entry point accepts its own non-loopback origin.
host.use((req, _res, next) => {
  if (req.headers.origin === `http://${req.headers.host}`) delete req.headers.origin;
  next();
});
host.use(express.json({ limit: '4mb' }));
host.get('/__verification', (_req, res) =>
  res.json({ mode: 'simulated', directory, queuedTurns: steps.length }),
);
host.post('/__verification/turns', (req, res) => {
  steps = z.array(stepSchema).min(1).max(20).parse(req.body.steps);
  if (req.body.transcript) transcript = z.string().max(1000).parse(req.body.transcript);
  res.json({ queuedTurns: steps.length, mode: 'simulated' });
});
host.post('/__verification/reset', async (req, res) => {
  const scene: Scene = sceneSchema.parse(req.body.scene);
  const before = await store.read();
  const project = {
    ...newProject(),
    scene,
    projectId: before.projectId,
    projectName: scene.name,
    revision: before.revision,
  };
  const saved = await store.save(project, before.revision);
  steps = [];
  res.json({ project: saved });
});
host.post('/__verification/render', async (req, res) => {
  try {
    const scene = sceneSchema.parse(req.body.scene);
    const request = renderRequestSchema.parse(req.body.request);
    const started = performance.now();
    const capture = await renders.provider(z.string().uuid().parse(req.body.clientId))(
      scene,
      request,
    );
    res.json({ ...capture, elapsedMs: performance.now() - started });
  } catch (error) {
    res.status(422).json({ error: (error as Error).message });
  }
});
host.use(app);
const vite = await createServer({
  server: { middlewareMode: true, hmr: { port: port + 20_000 } },
  appType: 'spa',
});
host.use(vite.middlewares);
host.listen(port, hostname, () =>
  console.log(
    `Simulated agent, real local app: http://${hostname}:${port}; data: ${directory}; cloud calls: disabled`,
  ),
);

import express from 'express';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { documentSchema, sceneSchema, messageSchema } from '../shared/model.ts';
import { commandsSchema, inspectDesign, validateDesign } from '../shared/design.ts';
import { DesignDraft } from '../shared/draft.ts';
import {
  agentContextSchema,
  type AgentUsage,
  type HarnessResult,
  type RunStatus,
} from '../shared/harness.ts';
import { ProjectStore, RevisionConflict } from './storage.ts';
import { runAgent, AgentRunError, type AgentModel } from './agent.ts';
import { DesignService, DesignServiceError } from './design-service.ts';
import { ConnectionStore, resolveConnections } from './connections.ts';
import {
  GatewayError,
  normalizeAudioMediaType,
  synthesizeSpeech,
  transcribeAudio,
} from './gateway.ts';

type Usage = { day: string; requests: number; modelCost: number };
type Run = { state: RunStatus; controller: AbortController; createdAt: number };
const revisionSchema = z.number().int().nonnegative();
const runIdSchema = z.string().uuid();

export async function createApplication(options: {
  directory: string;
  env?: NodeJS.ProcessEnv;
  modelClient?: AgentModel;
  audioFetcher?: typeof fetch;
}) {
  const { directory } = options;
  const store = new ProjectStore(directory);
  const designs = new DesignService(store);
  const connections = new ConnectionStore(directory);
  await connections.load();
  const gateway = () => resolveConnections(connections.get(), options.env || process.env);
  let usage: Usage = { day: new Date().toISOString().slice(0, 10), requests: 0, modelCost: 0 };
  try {
    usage = z
      .object({
        day: z.string(),
        requests: z.number().int().nonnegative(),
        modelCost: z.number().nonnegative(),
      })
      .parse(JSON.parse(await readFile(path.join(directory, 'usage.json'), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let usageQueue: Promise<unknown> = Promise.resolve();
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
      throw new DesignServiceError(
        'Daily cloud request limit reached. Adjust it in Connections if you want to continue.',
        429,
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
        if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname))
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
  app.get('/api/project', async (_req, res) => res.json(await store.read()));
  app.put('/api/project', async (req, res) => {
    const expectedRevision = revisionSchema.parse(req.body?.revision);
    const project = documentSchema.parse(req.body);
    const errors = validateDesign(project.scene).filter((i) => i.severity === 'error');
    if (errors.length)
      return res
        .status(422)
        .json({ error: errors.map((i) => i.message).join(' '), issues: errors });
    res.json({ ok: true, project: await store.save(project, expectedRevision) });
  });

  // Public control surface: the same service is reusable by a future MCP adapter.
  app.get('/api/design/capabilities', (_req, res) =>
    res.json({
      version: 1,
      operationSchema: z.toJSONSchema(commandsSchema, { target: 'draft-7' }),
      transactions: 'create → apply operations → inspect → commit with expectedRevision',
      confirmationRequiredFor: ['room deletion', 'changed requirements', 'major area changes'],
    }),
  );
  app.post('/api/design/inspect', async (_req, res) => {
    const project = await store.read();
    res.json({ revision: project.revision, inspection: inspectDesign(project.scene) });
  });
  app.post('/api/design/drafts', async (req, res) => {
    const { baseRevision } = z.object({ baseRevision: revisionSchema }).parse(req.body);
    const draft = await designs.create(baseRevision);
    res.json(designs.describe(draft.id));
  });
  app.get('/api/design/drafts/:id', (req, res) => res.json(designs.describe(req.params.id)));
  app.post('/api/design/drafts/:id/operations', (req, res) => {
    const { operations } = z.object({ operations: z.unknown() }).parse(req.body);
    res.json(designs.apply(req.params.id, operations));
  });
  app.delete('/api/design/drafts/:id', (req, res) => {
    designs.discard(req.params.id);
    res.json({ ok: true });
  });
  app.post('/api/design/drafts/:id/commit', async (req, res) => {
    const { expectedRevision, confirm } = z
      .object({ expectedRevision: revisionSchema, confirm: z.boolean().default(false) })
      .parse(req.body);
    res.json(await designs.commit(req.params.id, expectedRevision, confirm));
  });

  const runs = new Map<string, Run>();
  let agentBusy = false;
  app.get('/api/agent/runs/:id', (req, res) => {
    const run = runs.get(req.params.id);
    if (!run) return res.status(404).json({ error: 'This design run is not available.' });
    res.json(run.state);
  });
  app.post('/api/agent/runs/:id/cancel', (req, res) => {
    const run = runs.get(req.params.id);
    if (!run) return res.status(404).json({ error: 'This design run is not available.' });
    if (run.state.status === 'running') run.controller.abort();
    res.json({ ok: true });
  });
  app.post('/api/agent', async (req, res, next) => {
    const config = gateway();
    if (!config.key)
      return res.status(428).json({
        error: 'Add a Vercel AI Gateway key in Connections or AI_GATEWAY_API_KEY in .env to begin.',
      });
    if (agentBusy)
      return res.status(409).json({
        error: 'A design is already in progress. Please wait for it to finish or cancel it.',
      });
    let run: Run | undefined, draftId: string | undefined, result: HarnessResult | undefined;
    const runUsage: AgentUsage = { inputTokens: 0, outputTokens: 0, cost: 0, calls: 0 };
    let reportedCalls = 0;
    try {
      const input = z
        .object({
          runId: runIdSchema.optional(),
          baseRevision: revisionSchema.optional(),
          scene: sceneSchema,
          messages: z.array(messageSchema).min(1).max(100),
          context: agentContextSchema.optional(),
          previewOnly: z.boolean().default(false),
        })
        .parse(req.body);
      const id = input.runId || randomUUID();
      if (runs.has(id))
        throw new DesignServiceError(
          'This request was already submitted. Check its result before sending another.',
          409,
        );
      agentBusy = true;
      const entry = input.previewOnly
        ? undefined
        : await designs.create(revisionSchema.parse(input.baseRevision), input.scene);
      draftId = entry?.id;
      const draft = entry?.draft || new DesignDraft(input.scene);
      run = {
        controller: new AbortController(),
        createdAt: Date.now(),
        state: {
          id,
          status: 'running',
          stage: 'starting',
          message: 'Starting the design request.',
          events: [],
          preview: null,
          issues: [],
          changes: [],
        },
      };
      runs.set(id, run);
      for (const [key, old] of runs)
        if (
          old.state.status !== 'running' &&
          (runs.size > 40 || old.createdAt < Date.now() - 30 * 60_000)
        )
          runs.delete(key);
      const activeRun = run;
      res.on('close', () => {
        if (!res.writableEnded) activeRun.controller.abort();
      });
      const answer = await runAgent({
        key: config.key,
        model: config.model,
        scene: input.scene,
        messages: input.messages,
        context: input.context,
        draft,
        client: options.modelClient,
        signal: AbortSignal.any([run.controller.signal, AbortSignal.timeout(300_000)]),
        beforeModelCall: async () => {
          await chargeRequest();
          runUsage.calls++;
        },
        onUsage: async (cost) => {
          reportedCalls++;
          runUsage.inputTokens += cost.inputTokens;
          runUsage.outputTokens += cost.outputTokens;
          runUsage.cost =
            runUsage.cost === null || cost.cost === null ? null : runUsage.cost + cost.cost;
          if (cost.cost !== null) {
            resetDay();
            usage.modelCost += cost.cost;
            await persistUsage();
          }
        },
        onEvent: (event, preview) => {
          activeRun.state.stage = event.stage;
          activeRun.state.message = event.message;
          activeRun.state.events.push(event);
          activeRun.state.preview = preview;
          if (event.issues) activeRun.state.issues = event.issues;
          if (event.changes) activeRun.state.changes = event.changes;
        },
      });
      run.controller.signal.throwIfAborted();
      if (entry && answer.scene) {
        entry.reply = answer.reply;
        entry.needsConfirmation = answer.needsConfirmation;
        entry.ready = true;
      } else if (entry) {
        designs.discard(entry.id);
        draftId = undefined;
      }
      result = {
        ...answer,
        runId: id,
        baseRevision: entry?.baseRevision ?? input.baseRevision ?? 0,
        ...(draftId ? { draftId } : {}),
      };
      run.state.status = 'succeeded';
      run.state.stage = 'complete';
      run.state.message = answer.scene ? 'The validated draft is ready.' : 'The reply is ready.';
      res.json(result);
    } catch (error) {
      if (draftId) designs.discard(draftId);
      const cancelled = run?.controller.signal.aborted;
      const failure = cancelled
        ? new AgentRunError('Design cancelled. Your saved house is unchanged.')
        : error;
      if (run) {
        run.state.status = cancelled ? 'cancelled' : 'failed';
        run.state.stage = cancelled ? 'cancelled' : 'failed';
        run.state.error = failure instanceof Error ? failure.message : 'The design request failed.';
        run.state.message = run.state.error;
        run.state.preview = null;
        if (failure instanceof AgentRunError) run.state.issues = failure.issues;
      }
      next(failure);
    } finally {
      agentBusy = false;
      if (run) {
        // Local diagnostic summaries only: no credentials, image data, or private model reasoning.
        try {
          await mkdir(path.join(directory, 'runs'), { recursive: true, mode: 0o700 });
          await writeFile(
            path.join(directory, 'runs', `${run.state.id}.json`),
            JSON.stringify(
              {
                id: run.state.id,
                model: config.model,
                status: run.state.status,
                events: run.state.events,
                error: run.state.error,
                usage: result?.usage || {
                  ...runUsage,
                  cost: reportedCalls === runUsage.calls ? runUsage.cost : null,
                },
                changes: result?.changes || run.state.changes,
              },
              null,
              2,
            ),
            { mode: 0o600 },
          );
        } catch {
          // Diagnostics must never turn an already completed response into another failure.
        }
      }
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
        fetcher: options.audioFetcher,
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
      fetcher: options.audioFetcher,
    });
    res.type(result.mediaType).send(result.audio);
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API route.' }));
  app.use(
    (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (res.headersSent) return;
      const validation = error instanceof z.ZodError;
      const status = validation
        ? 400
        : error instanceof RevisionConflict
          ? 409
          : error instanceof DesignServiceError
            ? error.status
            : error instanceof AgentRunError
              ? 422
              : error instanceof GatewayError
                ? 502
                : 500;
      res.status(status).json({
        ...(error instanceof RevisionConflict ? { code: 'revision_conflict' } : {}),
        error: validation
          ? 'The request or settings were invalid. Reload the app if it was updated, or check the supplied values. Your saved house was not changed.'
          : error instanceof Error
            ? error.message
            : 'Unexpected local server error.',
        ...(error instanceof AgentRunError ? { issues: error.issues } : {}),
      });
    },
  );
  return { app, store, designs };
}

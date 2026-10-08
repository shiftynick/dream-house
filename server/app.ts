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
import { inheritedPreservationContext } from './refinement-review.ts';
import { AlternativeService } from './alternative-service.ts';
import { RenderBroker, RenderUnavailable } from './render-service.ts';
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
const projectIdSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_-]+$/);

export async function createApplication(options: {
  directory: string;
  env?: NodeJS.ProcessEnv;
  modelClient?: AgentModel;
  audioFetcher?: typeof fetch;
}) {
  const { directory } = options;
  const store = new ProjectStore(directory);
  const designs = new DesignService(store);
  const alternatives = new AlternativeService(store);
  const renders = new RenderBroker();
  let agentBusy = false;
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
  async function recordAudioCost(cost: number | null) {
    if (cost === null) return;
    resetDay();
    usage.modelCost += cost;
    await persistUsage();
  }
  function audioLifetime(res: express.Response) {
    const disconnected = new AbortController();
    const close = () => {
      if (!res.writableEnded) disconnected.abort();
    };
    res.on('close', close);
    return {
      signal: AbortSignal.any([disconnected.signal, AbortSignal.timeout(60_000)]),
      disconnected: () => disconnected.signal.aborted,
      cleanup: () => res.off('close', close),
    };
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
  app.use(express.json({ limit: '24mb' }));
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
  app.get('/api/projects', async (_req, res) => res.json(await store.list()));
  app.post('/api/projects', async (req, res) => {
    if (agentBusy)
      throw new DesignServiceError(
        'Finish or cancel the current design before opening another house.',
        409,
      );
    const input = z
      .object({
        name: z.string().trim().min(1).max(100),
        expectedProjectId: projectIdSchema,
        expectedRevision: revisionSchema,
      })
      .parse(req.body);
    res.json({
      project: await store.createProject(
        input.name,
        input.expectedProjectId,
        input.expectedRevision,
      ),
    });
  });
  app.post('/api/projects/:id/open', async (req, res) => {
    if (agentBusy)
      throw new DesignServiceError(
        'Finish or cancel the current design before opening another house.',
        409,
      );
    const input = z
      .object({ expectedProjectId: projectIdSchema, expectedRevision: revisionSchema })
      .parse(req.body);
    res.json({
      project: await store.openProject(
        projectIdSchema.parse(req.params.id),
        input.expectedProjectId,
        input.expectedRevision,
      ),
    });
  });
  app.put('/api/project', async (req, res) => {
    const expectedRevision = revisionSchema.parse(req.body?.revision);
    projectIdSchema.parse(req.body?.projectId);
    const project = documentSchema.parse(req.body);
    const errors = validateDesign(project.scene).filter((i) => i.severity === 'error');
    if (errors.length)
      return res
        .status(422)
        .json({ error: errors.map((i) => i.message).join(' '), issues: errors });
    res.json({ ok: true, project: await store.save(project, expectedRevision) });
  });

  app.post('/api/render/clients', (_req, res) => res.json(renders.register()));
  app.delete('/api/render/clients/:id', (req, res) => {
    renders.disconnect(req.params.id);
    res.json({ ok: true });
  });
  app.get('/api/render/jobs', async (req, res) => {
    const clientId = runIdSchema.parse(req.query.clientId);
    if (req.query.wait !== '1') return res.json(renders.poll(clientId));
    const afterId = runIdSchema.optional().parse(req.query.afterId);
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    try {
      const result = await renders.waitForJob(clientId, afterId, controller.signal);
      if (!controller.signal.aborted) res.json(result);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  });
  app.post('/api/render/jobs/:id/result', (req, res) => {
    const input = z
      .object({
        clientId: runIdSchema,
        result: z.unknown().optional(),
        error: z.string().min(1).max(600).optional(),
      })
      .parse(req.body);
    renders.submit(req.params.id, input.clientId, input.result, input.error);
    res.json({ ok: true });
  });

  // Public control surface: the same service is reusable by a future MCP adapter.
  app.get('/api/design/capabilities', (_req, res) =>
    res.json({
      version: 2,
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
    const { baseRevision, projectId } = z
      .object({ baseRevision: revisionSchema, projectId: projectIdSchema })
      .parse(req.body);
    const draft = await designs.create(baseRevision, undefined, projectId);
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
  app.post(
    ['/api/agent', '/api/design/drafts/:id/refine', '/api/alternatives/refine'],
    async (req, res, next) => {
      const config = gateway();
      if (!config.key)
        return res.status(428).json({
          error:
            'Add a Vercel AI Gateway key in Connections or AI_GATEWAY_API_KEY in .env to begin.',
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
            projectId: projectIdSchema.optional(),
            scene: sceneSchema.optional(),
            messages: z.array(messageSchema).min(1).max(100).optional(),
            prompt: z.string().trim().min(1).max(2000).optional(),
            choiceSetId: runIdSchema.optional(),
            optionId: runIdSchema.optional(),
            renderClientId: runIdSchema.optional(),
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
        if (input.context?.allowVisualReview && !renders.available(input.context.renderClientId))
          throw new RenderUnavailable();
        const refiningProposal = req.path.startsWith('/api/design/drafts/');
        const refiningOption = req.path === '/api/alternatives/refine';
        const refining = refiningProposal || refiningOption;
        if (refining && input.previewOnly)
          throw new DesignServiceError('Refinements use isolated server drafts.');
        let alternativeSource: Awaited<ReturnType<typeof alternatives.source>> | undefined;
        const projectId = refining ? projectIdSchema.parse(input.projectId) : input.projectId;
        const revision = refining ? revisionSchema.parse(input.baseRevision) : input.baseRevision;
        const prompt = refining
          ? z.string().trim().min(1).max(2000).parse(input.prompt)
          : undefined;
        if (refiningOption) {
          if (!renders.available(input.renderClientId)) throw new RenderUnavailable();
          alternativeSource = await alternatives.source(
            runIdSchema.parse(input.choiceSetId),
            runIdSchema.parse(input.optionId),
            projectId!,
            revision!,
          );
        }
        if (
          alternativeSource &&
          alternativeSource.project.variants.length + alternativeSource.optionCount >= 30
        )
          throw new DesignServiceError(
            'There is no room for another alternative. Remove a saved option first.',
          );
        const entry = refiningProposal
          ? await designs.refine(z.string().parse(req.params.id), revision!, projectId!)
          : alternativeSource
            ? await designs.createFromCandidate(
                revision!,
                projectId!,
                alternativeSource.scene,
                alternativeSource.original,
              )
            : input.previewOnly
              ? undefined
              : await designs.create(
                  revisionSchema.parse(input.baseRevision),
                  sceneSchema.parse(input.scene),
                  projectIdSchema.parse(input.projectId),
                );
        draftId = entry?.id;
        const draft = entry?.draft || new DesignDraft(sceneSchema.parse(input.scene));
        const startingScene = draft.scene;
        const savedProject = refining ? await store.read() : undefined;
        const sourceDescription =
          alternativeSource?.option.description ||
          (refiningProposal ? designs.get(z.string().parse(req.params.id)).reply : '');
        const sourceReview =
          alternativeSource?.reviewState ||
          (refiningProposal ? designs.get(z.string().parse(req.params.id)) : undefined);
        const refinementMessages = refining
          ? [
              ...savedProject!.messages.slice(-8),
              {
                id: randomUUID(),
                role: 'assistant' as const,
                text: `${sourceDescription || 'The displayed design is an unsaved proposal.'}\nInherited review checklist (retain required IDs/checks and resolve or disclose outstanding items): ${JSON.stringify(alternativeSource?.option.assessment || (refiningProposal ? designs.get(z.string().parse(req.params.id)).assessment : undefined))}\nImmutable original preservation baselines (these precede the current candidate; repair or disclose these constraints): ${JSON.stringify(inheritedPreservationContext(sourceReview))}\nInherited visual concerns: ${JSON.stringify(alternativeSource?.option.visualReview || (refiningProposal ? designs.get(z.string().parse(req.params.id)).visualReview : undefined))}`,
              },
              {
                id: randomUUID(),
                role: 'user' as const,
                text: `Refine this uncommitted ${alternativeSource ? 'alternative' : 'proposal'}: ${prompt}. Preserve its existing design intent, confirmed requirements and unrelated geometry. The saved house remains unchanged until the user adopts the result.`,
              },
            ]
          : z.array(messageSchema).min(1).max(100).parse(input.messages);
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
        let answer = await runAgent({
          key: config.key,
          model: config.model,
          scene: startingScene,
          messages: refinementMessages,
          context: input.context,
          draft,
          client: options.modelClient,
          render: input.context?.allowVisualReview
            ? renders.provider(input.context.renderClientId!)
            : undefined,
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
          answer = designs.complete(entry.id, answer, input.context);
          if (designs.describe(entry.id).issues.some((issue) => issue.severity === 'error'))
            throw new DesignServiceError('The refinement violates the saved house design checks.');
        } else if (entry) {
          designs.discard(entry.id);
          draftId = undefined;
        }
        let refinedAlternative:
          Awaited<ReturnType<typeof alternatives.appendRefinement>> | undefined;
        if (alternativeSource && answer.scene) {
          refinedAlternative = await alternatives.appendRefinement({
            choiceSetId: input.choiceSetId!,
            optionId: input.optionId!,
            projectId: projectId!,
            expectedRevision: revision!,
            answer,
            context: input.context,
            render: renders.provider(input.renderClientId!),
            signal: run.controller.signal,
          });
          answer = refinedAlternative.answer;
          if (draftId) designs.discard(draftId);
          draftId = undefined;
        }
        result = {
          ...answer,
          ...(refining && answer.scene ? { needsConfirmation: true } : {}),
          ...(refinedAlternative
            ? {
                choices: refinedAlternative.choices,
                refinedOptionId: refinedAlternative.refinedOptionId,
              }
            : {}),
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
          run.state.error =
            failure instanceof Error ? failure.message : 'The design request failed.';
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
    },
  );
  app.post('/api/alternatives/generate', async (req, res, next) => {
    if (agentBusy)
      return res
        .status(409)
        .json({ error: 'Another design request is in progress. Finish or cancel it first.' });
    const config = gateway();
    if (!config.key)
      return res
        .status(428)
        .json({ error: 'Add a Vercel AI Gateway key to explore alternatives.' });
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(600_000)]);
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      const input = z
        .object({
          projectId: projectIdSchema,
          baseRevision: revisionSchema,
          prompt: z.string().trim().min(1).max(2000),
          count: z.union([z.literal(2), z.literal(3)]).default(2),
          renderClientId: runIdSchema,
          context: agentContextSchema.optional(),
        })
        .parse(req.body);
      if (!renders.available(input.renderClientId)) throw new RenderUnavailable();
      agentBusy = true;
      const project = await store.read();
      if (project.projectId !== input.projectId || project.revision !== input.baseRevision)
        throw new RevisionConflict();
      const result = await alternatives.generate({
        project,
        prompt: input.prompt,
        count: input.count,
        context: input.context,
        render: renders.provider(input.renderClientId),
        signal,
        build: async (index, previous) =>
          runAgent({
            key: config.key,
            model: config.model,
            client: options.modelClient,
            scene: project.scene,
            messages: [
              ...project.messages.slice(-8),
              {
                id: randomUUID(),
                role: 'user',
                text: `Create visual alternative ${index + 1} of ${input.count} for this request: ${input.prompt}\nMake a concrete, visibly distinct design using the editing tools; preserve confirmed requirements and unrelated geometry. Make reasonable design assumptions. This is an unsaved option the user will review. ${previous.length ? `Other options already generated (make this one meaningfully different): ${JSON.stringify(previous.map((p) => ({ description: p.description, scene: p.scene })))}` : ''}`,
              },
            ],
            context: input.context,
            render: input.context?.allowVisualReview
              ? renders.provider(input.renderClientId)
              : undefined,
            signal,
            beforeModelCall: chargeRequest,
            onUsage: async (cost) => {
              if (cost.cost !== null) {
                resetDay();
                usage.modelCost += cost.cost;
                await persistUsage();
              }
            },
          }),
      });
      signal.throwIfAborted();
      res.json(result);
    } catch (error) {
      next(
        controller.signal.aborted
          ? new AgentRunError('Alternative generation cancelled. Your saved house is unchanged.')
          : error,
      );
    } finally {
      agentBusy = false;
    }
  });
  app.post('/api/alternatives/refinements/discard', async (req, res) => {
    const input = z
      .object({
        projectId: projectIdSchema,
        expectedRevision: revisionSchema,
        choiceSetId: runIdSchema,
        optionId: runIdSchema,
      })
      .parse(req.body);
    res.json({
      choices: await alternatives.discardRefinement(
        input.choiceSetId,
        input.optionId,
        input.projectId,
        input.expectedRevision,
      ),
    });
  });
  app.post('/api/alternatives/choose', async (req, res) => {
    const input = z
      .object({
        projectId: projectIdSchema,
        expectedRevision: revisionSchema,
        choiceSetId: runIdSchema,
        optionId: runIdSchema,
        preferenceText: z.string().max(1000).default(''),
        confirm: z.boolean().default(false),
      })
      .parse(req.body);
    res.json({
      project: await alternatives.choose(
        input.choiceSetId,
        input.optionId,
        input.projectId,
        input.expectedRevision,
        input.preferenceText,
        input.confirm,
      ),
    });
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
      const lifetime = audioLifetime(res);
      try {
        await chargeRequest();
        lifetime.signal.throwIfAborted();
        const result = await transcribeAudio({
          key: config.key,
          model: config.transcriptionModel,
          audio: req.body,
          mediaType,
          signal: lifetime.signal,
          fetcher: options.audioFetcher,
        });
        // A provider may finish despite cancellation; retain its reported charge.
        await recordAudioCost(result.cost);
        if (!lifetime.disconnected()) res.json({ text: result.text });
      } catch (error) {
        if (!lifetime.disconnected()) throw error;
      } finally {
        lifetime.cleanup();
      }
    },
  );
  app.post('/api/speak', async (req, res) => {
    const config = gateway();
    if (!config.key)
      return res
        .status(428)
        .json({ error: 'Add a Vercel AI Gateway key in Connections for cloud speech.' });
    const { text } = z.object({ text: z.string().min(1).max(1500) }).parse(req.body);
    const lifetime = audioLifetime(res);
    try {
      await chargeRequest();
      lifetime.signal.throwIfAborted();
      const result = await synthesizeSpeech({
        key: config.key,
        model: config.speechModel,
        voice: config.speechVoice,
        text,
        signal: lifetime.signal,
        fetcher: options.audioFetcher,
      });
      await recordAudioCost(result.cost);
      if (!lifetime.disconnected()) res.type(result.mediaType).send(result.audio);
    } catch (error) {
      if (!lifetime.disconnected()) throw error;
    } finally {
      lifetime.cleanup();
    }
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
                : error instanceof RenderUnavailable
                  ? 409
                  : 500;
      res.status(status).json({
        ...(error instanceof RevisionConflict
          ? { code: 'revision_conflict' }
          : error instanceof DesignServiceError && error.code
            ? { code: error.code }
            : {}),
        error: validation
          ? 'The request or settings were invalid. Reload the app if it was updated, or check the supplied values. Your saved house was not changed.'
          : error instanceof Error
            ? error.message
            : 'Unexpected local server error.',
        ...(error instanceof AgentRunError ? { issues: error.issues } : {}),
      });
    },
  );
  return { app, store, designs, renders, alternatives };
}

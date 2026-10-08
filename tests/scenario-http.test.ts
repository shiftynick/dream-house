import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../server/app.ts';
import type { AgentModel, ModelTurn } from '../server/agent.ts';
import { designPlanSchema, planAssessment } from '../server/design-planning.ts';
import { ProjectStore } from '../server/storage.ts';
import { newProject, makeRoom, redo, undo, type Project } from '../shared/model.ts';
import { renderCamera, type RenderJob } from '../shared/render.ts';
import { executeCommands } from '../shared/design.ts';
import { cabinOperations } from '../scripts/scenarios.ts';

const messages = [
  {
    id: 'brief',
    role: 'user',
    text: 'A warm mountain cabin with a single-pitch roof, big south windows, and connected bedroom and bathroom.',
  },
];
const assessment = {
  requirements: [
    {
      id: 'roof',
      request: 'Single-pitch roof.',
      status: 'fulfilled',
      evidence: 'The effective roof is checked.',
      checks: [
        { kind: 'roof', roomId: 'living', style: 'single-pitch', pitch: 12, direction: 'north' },
      ],
    },
    {
      id: 'south-windows',
      request: 'Large south-facing windows.',
      status: 'fulfilled',
      evidence: 'Two dimensioned windows share the south wall with the deck door.',
      checks: [
        {
          kind: 'wall_opening',
          roomId: 'living',
          side: 'south',
          openingKind: 'window',
          minCount: 2,
          minWidth: 2.4,
          minHeight: 2.3,
        },
        {
          kind: 'wall_opening',
          roomId: 'living',
          side: 'south',
          openingKind: 'door',
          minWidth: 1.2,
        },
      ],
    },
    {
      id: 'access',
      request: 'Attached bedroom and bathroom.',
      status: 'fulfilled',
      evidence: 'Both rooms have indoor access from the living room.',
      checks: [{ kind: 'indoor_route', roomIds: ['living', 'bedroom', 'bathroom'] }],
    },
  ],
};
const cabinPlan = designPlanSchema.parse({
  intent: 'Complete the requested connected cabin with a coherent cedar scheme and real windows.',
  roomProgram: [
    {
      roomId: 'living',
      name: 'Living and kitchen',
      kind: 'living',
      purpose: 'Gathering and cooking',
    },
    { roomId: 'bedroom', name: 'Bedroom', kind: 'bedroom', purpose: 'Sleeping' },
    { roomId: 'bathroom', name: 'Bathroom', kind: 'bathroom', purpose: 'Bathing' },
    { roomId: 'deck', name: 'South deck', kind: 'terrace', purpose: 'Outdoor gathering' },
  ],
  materialStrategy: {
    description: 'Coordinated cedar walls and roof.',
    checks: [
      {
        kind: 'material_composition',
        surfaces: ['exterior-walls', 'roof'],
        allowedPalettes: ['cedar'],
        maxDistinct: 1,
      },
    ],
  },
  fenestration: {
    description: 'Real occupied-room exterior windows.',
    roomIds: ['living', 'bedroom'],
  },
  features: assessment.requirements.map((item) => ({
    id: item.id,
    request: item.request,
    checks: item.checks,
  })),
  reviewViews: ['exterior', 'plan'],
});
const cabinAssessment = {
  ...planAssessment(cabinPlan),
  requirements: planAssessment(cabinPlan).requirements.map((item) => ({
    ...item,
    status: 'fulfilled',
    evidence: 'Checked.',
  })),
};
let sequence = 0;
function turn(calls: Array<[string, unknown]>): ModelTurn {
  return {
    calls: calls.map(([name, args]) => ({
      id: `scenario-${sequence++}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    })),
    content: null,
    truncated: false,
    usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(
  t: TestContext,
  options: { modelClient?: AgentModel; audioFetcher?: typeof fetch; seedLiving?: boolean } = {},
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'terrain-scenario-http-'));
  const { seedLiving, ...applicationOptions } = options;
  // These existing-house lifecycle cases remain focused edits; the empty-site
  // creation case below exercises the mandatory plan and separate critic.
  const modelClient = applicationOptions.modelClient;
  const application = await createApplication({
    directory,
    env: { AI_GATEWAY_API_KEY: 'synthetic-test-only' },
    ...applicationOptions,
    ...(seedLiving && modelClient
      ? {
          modelClient: {
            async complete(...args: Parameters<AgentModel['complete']>) {
              const response = await modelClient.complete(...args);
              for (const call of response.calls) {
                if (call.function.name !== 'apply_operations') continue;
                const input = JSON.parse(call.function.arguments);
                input.operations = input.operations.map((operation: any) =>
                  operation.type === 'add_rooms'
                    ? {
                        ...operation,
                        rooms: operation.rooms.filter((room: any) => room.id !== 'living'),
                      }
                    : operation,
                );
                call.function.arguments = JSON.stringify(input);
              }
              return response;
            },
          },
        }
      : {}),
  });
  const initial = newProject();
  if (seedLiving)
    initial.scene.rooms = [
      makeRoom({
        id: 'living',
        name: 'Living and kitchen',
        kind: 'living',
        width: 8,
        depth: 6,
        height: 3.1,
      }),
    ];
  const project = await application.store.save(initial);
  const server = application.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  });
  const http = async (route: string, method = 'GET', body?: unknown) => {
    const response = await fetch(origin + route, {
      method,
      ...(body !== undefined
        ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  const agentInput = (extra: object = {}) => ({
    runId: randomUUID(),
    baseRevision: project.revision,
    projectId: project.projectId,
    scene: project.scene,
    messages,
    ...extra,
  });
  return { ...application, directory, project, origin, http, agentInput };
}

test(
  'simulated cabin creation crosses real HTTP tools, assessment, capture protocol, commit, undo/redo and reopened storage',
  { timeout: 10000 },
  async (t) => {
    let round = 0;
    const app = await fixture(t, {
      modelClient: {
        async complete(history, _signal, tools) {
          if (tools?.includes('submit_design_critique'))
            return turn([
              [
                'submit_design_critique',
                {
                  intentReview: {
                    status: 'adequate',
                    evidence: 'The requested cabin program, roof and glazing are complete.',
                    missingObjectives: [],
                  },
                  captureIds: ['capture-1', 'capture-2'],
                  observations: cabinAssessment.requirements.map((item) => ({
                    objectiveId: item.id,
                    status: 'satisfactory',
                    evidence: 'Checked against current geometry and views.',
                  })),
                  limitations: [],
                },
              ],
            ]);
          round++;
          if (round === 1) return turn([['plan_design', cabinPlan]]);
          if (round === 2) return turn([['apply_operations', { operations: cabinOperations() }]]);
          if (round === 3)
            return turn([
              ['review_design', cabinAssessment],
              ['render_view', { view: 'exterior', angle: 'southeast' }],
              ['render_view', { view: 'plan' }],
            ]);
          if (round === 4) return turn([['critique_design', {}]]);
          assert.ok(
            history.some(
              (message) =>
                Array.isArray(message.content) &&
                message.content.some((part) => part.type === 'image_url'),
            ),
            'completion receives the matching capture in the next model call',
          );
          return turn([
            [
              'finish_design',
              {
                mode: 'apply',
                reply:
                  'The cabin has a single-pitch roof, south-facing windows, and connected sleeping and bathroom spaces.',
                assessment: cabinAssessment,
                visualReview: {
                  status: 'passed',
                  captureIds: ['capture-1', 'capture-2'],
                  observations: [
                    'The supplied exterior color view shows the cabin roof and coordinated wall materials.',
                  ],
                },
              },
            ],
          ]);
        },
      },
    });
    const clientId = (await app.http('/api/render/clients', 'POST')).body.clientId;
    t.after(() => app.renders.disconnect(clientId));
    const listening = app.http(`/api/render/jobs?clientId=${clientId}&wait=1`);
    const run = app.http(
      '/api/agent',
      'POST',
      app.agentInput({ context: { allowVisualReview: true, renderClientId: clientId } }),
    );
    let nextJob = listening;
    for (let index = 0; index < 2; index++) {
      const job = (await nextJob).body.job as RenderJob;
      assert.equal(job.scene.roof, 'single-pitch');
      const { position, target } = renderCamera(job.scene, job.request);
      const submitted = await app.http(`/api/render/jobs/${job.id}/result`, 'POST', {
        clientId,
        result: {
          image: 'data:image/png;base64,YWJj',
          width: 768,
          height: 576,
          view: job.request.view,
          sceneHash: job.sceneHash,
          camera: { position, target },
        },
      });
      assert.equal(submitted.status, 200);
      if (index === 0) nextJob = app.http(`/api/render/jobs?clientId=${clientId}&wait=1`);
    }
    const result = await run;
    assert.equal(result.status, 200);
    assert.equal(result.body.needsConfirmation, false);
    assert.equal(result.body.usage.cost, 0);
    assert.equal(result.body.metrics.captures, 2);
    assert.ok(
      result.body.assessment.requirements.every(
        (item: { status: string }) => item.status === 'fulfilled',
      ),
    );
    assert.deepEqual(
      await app.store.read(),
      app.project,
      'even a finished valid run has no implicit save',
    );
    const committed = await app.http(`/api/design/drafts/${result.body.draftId}/commit`, 'POST', {
      expectedRevision: app.project.revision,
    });
    assert.equal(committed.status, 200);
    const built: Project = committed.body.project;
    assert.equal(built.scene.roof, 'single-pitch');
    assert.equal(
      built.scene.rooms
        .find((room) => room.id === 'living')
        ?.wallOpenings?.filter((opening) => opening.side === 'south' && opening.kind === 'window')
        .length,
      2,
    );
    assert.deepEqual(await new ProjectStore(app.directory).read(), built);
    const undone = await app.http('/api/project', 'PUT', undo(built));
    assert.equal(undone.status, 200);
    assert.equal(undone.body.project.scene.rooms.length, 0);
    const restored = await app.http('/api/project', 'PUT', redo(undone.body.project));
    assert.equal(restored.status, 200);
    assert.deepEqual(restored.body.project.scene, built.scene);
    assert.deepEqual((await new ProjectStore(app.directory).read()).scene, built.scene);
    const status = await app.http('/api/status');
    assert.equal(
      status.body.usage.requests,
      6,
      'five builder turns and the separate critic consume request slots',
    );
    assert.equal(status.body.usage.modelCost, 0);
  },
);

test(
  'a valid partial request remains an unsaved proposal and cannot commit without explicit confirmation',
  { timeout: 5000 },
  async (t) => {
    let round = 0;
    const app = await fixture(t, {
      seedLiving: true,
      modelClient: {
        async complete() {
          if (++round === 1)
            return turn([
              [
                'apply_operations',
                {
                  operations: cabinOperations().map((operation) =>
                    operation.type === 'set_roof' ? { ...operation, style: 'flat' } : operation,
                  ),
                },
              ],
            ]);
          return turn([
            ['finish_design', { mode: 'apply', reply: 'The cabin draft is ready.', assessment }],
          ]);
        },
      },
    });
    const result = await app.http('/api/agent', 'POST', app.agentInput());
    assert.equal(result.status, 200);
    assert.equal(result.body.needsConfirmation, true);
    assert.equal(result.body.assessment.requirements[0].status, 'partial');
    assert.match(result.body.reply, /Still outstanding: Single-pitch roof/);
    const attempted = await app.http(`/api/design/drafts/${result.body.draftId}/commit`, 'POST', {
      expectedRevision: app.project.revision,
    });
    assert.equal(attempted.status, 409);
    assert.deepEqual(await new ProjectStore(app.directory).read(), app.project);
    await app.http(`/api/design/drafts/${result.body.draftId}`, 'DELETE');
    assert.deepEqual(await app.store.read(), app.project);
  },
);

test(
  'a finished draft cannot overwrite a different project even when its revision matches',
  { timeout: 5000 },
  async (t) => {
    let round = 0;
    const app = await fixture(t, {
      seedLiving: true,
      modelClient: {
        async complete() {
          if (++round === 1) return turn([['apply_operations', { operations: cabinOperations() }]]);
          return turn([
            ['finish_design', { mode: 'apply', reply: 'The cabin draft is ready.', assessment }],
          ]);
        },
      },
    });
    const result = await app.http('/api/agent', 'POST', app.agentInput());
    assert.equal(result.status, 200);
    const opened = await app.http('/api/projects', 'POST', {
      name: 'Another house',
      expectedProjectId: app.project.projectId,
      expectedRevision: app.project.revision,
    });
    assert.equal(opened.status, 200);
    const attempted = await app.http(`/api/design/drafts/${result.body.draftId}/commit`, 'POST', {
      expectedRevision: opened.body.project.revision,
      confirm: true,
    });
    assert.equal(attempted.status, 409);
    assert.equal(attempted.body.code, 'revision_conflict');
    assert.deepEqual(await app.store.read(), opened.body.project);
    assert.equal(opened.body.project.scene.rooms.length, 0);
  },
);

function syntheticWav() {
  const wav = Buffer.alloc(44 + 128);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(128, 40);
  return wav;
}

test(
  'synthetic transcription and speech exercise real HTTP adapters and persist only reported audio costs',
  { timeout: 5000 },
  async (t) => {
    const wav = syntheticWav();
    const calls: string[] = [];
    const app = await fixture(t, {
      audioFetcher: async (input, options) => {
        calls.push(String(input));
        const body = JSON.parse(String(options?.body));
        if (String(input).endsWith('/transcription-model')) {
          assert.equal(body.mediaType, 'audio/webm');
          assert.equal(Buffer.from(body.audio, 'base64').length, 1000);
          return Response.json({ text: 'Add a large south window.', usage: { cost: 0.007 } });
        }
        assert.ok(String(input).endsWith('/speech-model'));
        assert.equal(body.text, 'The window is ready.');
        return Response.json({
          audio: wav.toString('base64'),
          providerMetadata: { gateway: { cost: '0.011' } },
        });
      },
    });
    const transcribed = await fetch(`${app.origin}/api/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm;codecs=opus' },
      body: Buffer.alloc(1000),
    });
    assert.equal(transcribed.status, 200);
    assert.deepEqual(await transcribed.json(), { text: 'Add a large south window.' });
    const speech = await fetch(`${app.origin}/api/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'The window is ready.' }),
    });
    assert.equal(speech.status, 200);
    assert.match(speech.headers.get('Content-Type')!, /audio\/wav/);
    assert.deepEqual(Buffer.from(await speech.arrayBuffer()), wav);
    assert.equal(calls.length, 2);
    const status = (await app.http('/api/status')).body;
    assert.equal(status.usage.requests, 2);
    assert.ok(Math.abs(status.usage.modelCost - 0.018) < 1e-10);
    assert.equal(JSON.stringify(status).includes('synthetic-test-only'), false);
    const restarted = await createApplication({ directory: app.directory, env: {} });
    assert.deepEqual(await restarted.store.read(), app.project, 'audio never changes the house');
    const usage = JSON.parse(await readFile(path.join(app.directory, 'usage.json'), 'utf8'));
    assert.ok(Math.abs(usage.modelCost - 0.018) < 1e-10);
  },
);

test(
  'client cancellation aborts upstream speech and transcription without stale responses or invented costs',
  { timeout: 5000 },
  async (t) => {
    for (const route of ['transcribe', 'speak']) {
      const entered = deferred<void>(),
        upstreamAborted = deferred<void>();
      const app = await fixture(t, {
        audioFetcher: async (_input, options) => {
          assert.ok(options?.signal);
          entered.resolve();
          return new Promise<Response>((_resolve, reject) =>
            options.signal!.addEventListener(
              'abort',
              () => {
                upstreamAborted.resolve();
                reject(options.signal!.reason);
              },
              { once: true },
            ),
          );
        },
      });
      const controller = new AbortController();
      const pending = fetch(`${app.origin}/api/${route}`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': route === 'speak' ? 'application/json' : 'audio/webm' },
        body:
          route === 'speak' ? JSON.stringify({ text: 'A canceled reply.' }) : Buffer.alloc(1000),
      });
      await entered.promise;
      const rejected = assert.rejects(pending, { name: 'AbortError' });
      controller.abort();
      await Promise.all([rejected, upstreamAborted.promise]);
      const status = await app.http('/api/status');
      assert.equal(status.body.usage.requests, 1);
      assert.equal(status.body.usage.modelCost, 0, 'no cost was reported; do not invent a charge');
      assert.deepEqual(await app.store.read(), app.project);
    }
  },
);

test(
  'a provider that finishes despite audio cancellation still has its reported charge recorded',
  { timeout: 5000 },
  async (t) => {
    const entered = deferred<void>(),
      aborted = deferred<void>(),
      response = deferred<Response>();
    const app = await fixture(t, {
      audioFetcher: async (_input, options) => {
        options?.signal?.addEventListener('abort', () => aborted.resolve(), { once: true });
        entered.resolve();
        return response.promise;
      },
    });
    const controller = new AbortController();
    const pending = fetch(`${app.origin}/api/transcribe`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'audio/webm' },
      body: Buffer.alloc(1000),
    });
    await entered.promise;
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    controller.abort();
    await Promise.all([rejected, aborted.promise]);
    response.resolve(
      Response.json({ text: 'Do not deliver this stale transcript.', usage: { cost: 0.004 } }),
    );
    const status = await app.http('/api/status');
    assert.equal(status.body.usage.requests, 1);
    assert.equal(status.body.usage.modelCost, 0.004);
    assert.deepEqual(await app.store.read(), app.project);
  },
);

test(
  'negative visual review survives HTTP and blocks DesignService commit until confirmation',
  { timeout: 10000 },
  async (t) => {
    let round = 0;
    const app = await fixture(t, {
      seedLiving: true,
      modelClient: {
        async complete() {
          round++;
          if (round === 1) return turn([['apply_operations', { operations: cabinOperations() }]]);
          if (round === 2) return turn([['render_view', { view: 'exterior' }]]);
          return turn([
            [
              'finish_design',
              {
                mode: 'apply',
                reply: 'The cabin draft is ready.',
                assessment,
                visualReview: {
                  status: 'issues',
                  captureIds: ['capture-1'],
                  observations: ['The roof panels appear inconsistent.'],
                  limitations: ['This is a model judgment from one exterior view.'],
                },
              },
            ],
          ]);
        },
      },
    });
    const clientId = (await app.http('/api/render/clients', 'POST')).body.clientId;
    t.after(() => app.renders.disconnect(clientId));
    const listening = app.http(`/api/render/jobs?clientId=${clientId}&wait=1`);
    const run = app.http(
      '/api/agent',
      'POST',
      app.agentInput({ context: { allowVisualReview: true, renderClientId: clientId } }),
    );
    const job = (await listening).body.job as RenderJob;
    const { position, target } = renderCamera(job.scene, job.request);
    await app.http(`/api/render/jobs/${job.id}/result`, 'POST', {
      clientId,
      result: {
        image: 'data:image/png;base64,YWJj',
        width: 768,
        height: 576,
        view: job.request.view,
        sceneHash: job.sceneHash,
        camera: { position, target },
      },
    });
    const result = await run;
    assert.equal(result.status, 200);
    assert.equal(result.body.visualReview.status, 'issues');
    assert.equal(result.body.visualReview.captures[0].quality, 'live');
    assert.equal(result.body.needsConfirmation, true);
    assert.match(result.body.reply, /roof panels appear inconsistent/);
    assert.equal(JSON.stringify(result.body.visualReview).includes('base64'), false);
    const blocked = await app.http(`/api/design/drafts/${result.body.draftId}/commit`, 'POST', {
      expectedRevision: app.project.revision,
    });
    assert.equal(blocked.status, 409);
    assert.deepEqual(await app.store.read(), app.project);
    const accepted = await app.http(`/api/design/drafts/${result.body.draftId}/commit`, 'POST', {
      expectedRevision: app.project.revision,
      confirm: true,
    });
    assert.equal(accepted.status, 200);
    assert.match(accepted.body.reply, /roof panels appear inconsistent/);
  },
);

test(
  'HTTP proposal refinement starts from the unsaved candidate, retains it, and adopts cumulatively once',
  { timeout: 10000 },
  async (t) => {
    let round = 0;
    const app = await fixture(t, {
      seedLiving: true,
      modelClient: {
        async complete(history) {
          round++;
          if (round === 1) return turn([['apply_operations', { operations: cabinOperations() }]]);
          if (round === 2)
            return turn([
              ['finish_design', { mode: 'propose', reply: 'Review the cabin.', assessment }],
            ]);
          if (round === 3) {
            assert.match(String(history[1].content), /"id":"living"/);
            assert.match(JSON.stringify(history), /Refine this uncommitted proposal/);
            return turn([
              [
                'apply_operations',
                {
                  operations: [
                    {
                      type: 'set_surface_material',
                      roomId: 'living',
                      surface: 'floor',
                      palette: 'cedar',
                    },
                  ],
                },
              ],
            ]);
          }
          return turn([
            ['finish_design', { mode: 'apply', reply: 'The cabin floor is cedar.', assessment }],
          ]);
        },
      },
    });
    const proposal = await app.http('/api/agent', 'POST', app.agentInput());
    assert.equal(proposal.status, 200);
    const before = structuredClone(app.designs.describe(proposal.body.draftId));
    const refinement = await app.http(
      `/api/design/drafts/${proposal.body.draftId}/refine`,
      'POST',
      {
        projectId: app.project.projectId,
        baseRevision: app.project.revision,
        prompt: 'Make the living room floor cedar.',
        context: {
          allowVisualReview: false,
          selection: { roomId: 'living', surface: 'floor' },
          editScope: { roomId: 'living', surface: 'floor' },
        },
      },
    );
    assert.equal(refinement.status, 200);
    assert.notEqual(refinement.body.draftId, proposal.body.draftId);
    assert.equal(refinement.body.needsConfirmation, true);
    assert.equal(refinement.body.editScopeReview.preserved, true);
    assert.deepEqual(app.designs.describe(proposal.body.draftId), before);
    assert.deepEqual(await app.store.read(), app.project);
    const blocked = await app.http(`/api/design/drafts/${refinement.body.draftId}/commit`, 'POST', {
      expectedRevision: app.project.revision,
    });
    assert.equal(blocked.status, 409);
    const accepted = await app.http(
      `/api/design/drafts/${refinement.body.draftId}/commit`,
      'POST',
      { expectedRevision: app.project.revision, confirm: true },
    );
    assert.equal(accepted.status, 200);
    assert.equal(
      accepted.body.project.scene.rooms.find((room: { id: string }) => room.id === 'living')
        .surfacePalettes.floor,
      'cedar',
    );
    assert.equal(accepted.body.project.past.length, 1);
    assert.deepEqual(accepted.body.project.past[0], app.project.scene);
  },
);

test(
  'HTTP refinement cancellation preserves the source proposal and saved project',
  { timeout: 10000 },
  async (t) => {
    const entered = deferred<void>();
    const app = await fixture(t, {
      modelClient: {
        async complete(_history, signal) {
          entered.resolve();
          return await new Promise<ModelTurn>((_resolve, reject) =>
            signal!.addEventListener(
              'abort',
              () => reject(new DOMException('Cancelled', 'AbortError')),
              { once: true },
            ),
          );
        },
      },
    });
    const source = await app.designs.create(app.project.revision);
    app.designs.apply(source.id, cabinOperations());
    const before = structuredClone(app.designs.describe(source.id));
    const runId = randomUUID();
    const pending = app.http(`/api/design/drafts/${source.id}/refine`, 'POST', {
      runId,
      projectId: app.project.projectId,
      baseRevision: app.project.revision,
      prompt: 'Make the floor cedar.',
      context: { allowVisualReview: false },
    });
    await entered.promise;
    assert.equal((await app.http(`/api/agent/runs/${runId}/cancel`, 'POST')).status, 200);
    const result = await pending;
    assert.notEqual(result.status, 200);
    assert.match(result.body.error, /cancelled/i);
    assert.deepEqual(app.designs.describe(source.id), before);
    assert.deepEqual(await app.store.read(), app.project);
  },
);

test(
  'HTTP alternative refinement appends an unsaved copy and enforces outstanding-item confirmation on adoption',
  { timeout: 10000 },
  async (t) => {
    let round = 0;
    const app = await fixture(t, {
      modelClient: {
        async complete() {
          if (++round === 1)
            return turn([
              [
                'apply_operations',
                {
                  operations: [
                    {
                      type: 'set_surface_material',
                      roomId: 'living',
                      surface: 'floor',
                      palette: 'cedar',
                    },
                  ],
                },
              ],
            ]);
          return turn([
            [
              'finish_design',
              {
                mode: 'propose',
                reply: 'Review the refined floor and roof preference.',
                assessment: {
                  requirements: [
                    {
                      id: 'roof-preference',
                      request: 'A steeper roof.',
                      status: 'unverified',
                      evidence: 'The roof was kept as before.',
                      limitation: 'The requested pitch is unresolved.',
                    },
                  ],
                },
              },
            ],
          ]);
        },
      },
    });
    const capture = async (
      scene: Parameters<typeof renderCamera>[0],
      request: Parameters<typeof renderCamera>[1],
    ) => {
      const { position, target } = renderCamera(scene, request);
      const { sceneFingerprint } = await import('../server/render-service.ts');
      return {
        image: 'data:image/png;base64,YWJj',
        width: 768,
        height: 576,
        sceneHash: sceneFingerprint(scene),
        view: request.view,
        camera: { position, target },
      };
    };
    const base = executeCommands(app.project.scene, cabinOperations()).scene;
    const choices = await app.alternatives.generate({
      project: app.project,
      prompt: 'Explore cabin materials.',
      count: 2,
      render: capture,
      build: async (index) => ({
        scene: { ...base, palette: index ? 'chalk' : 'cedar' },
        reply: 'A cabin option.',
        needsConfirmation: false,
        issues: [],
        changes: ['Built cabin.'],
        events: [],
        usage: { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 },
      }),
    });
    const clientId = (await app.http('/api/render/clients', 'POST')).body.clientId;
    t.after(() => app.renders.disconnect(clientId));
    const listening = app.http(`/api/render/jobs?clientId=${clientId}&wait=1`);
    const running = app.http('/api/alternatives/refine', 'POST', {
      projectId: app.project.projectId,
      baseRevision: app.project.revision,
      choiceSetId: choices.choiceSetId,
      optionId: choices.options[0].id,
      prompt: 'Make the living floor cedar.',
      renderClientId: clientId,
      context: { allowVisualReview: false },
    });
    const job = (await listening).body.job as RenderJob;
    await app.http(`/api/render/jobs/${job.id}/result`, 'POST', {
      clientId,
      result: await capture(job.scene, job.request),
    });
    const refined = await running;
    assert.equal(refined.status, 200);
    assert.equal(refined.body.draftId, undefined);
    assert.equal(refined.body.choices.options.length, 3);
    assert.deepEqual(
      refined.body.choices.options.slice(0, 2),
      JSON.parse(JSON.stringify(choices.options)),
    );
    assert.deepEqual(await app.store.read(), app.project);
    const adoption = {
      projectId: app.project.projectId,
      expectedRevision: app.project.revision,
      choiceSetId: choices.choiceSetId,
      optionId: refined.body.refinedOptionId,
    };
    assert.equal((await app.http('/api/alternatives/choose', 'POST', adoption)).status, 409);
    const accepted = await app.http('/api/alternatives/choose', 'POST', {
      ...adoption,
      confirm: true,
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.project.past.length, 1);
    assert.equal(accepted.body.project.variants.length, 3);
  },
);

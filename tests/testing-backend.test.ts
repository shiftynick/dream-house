import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApplication } from '../server/app.ts';
import { resolveTestingBackend } from '../server/connections.ts';
import { makeRoom, newProject } from '../shared/model.ts';
import type { AgentModel, ModelTurn } from '../server/agent.ts';

async function fixture(
  t: TestContext,
  options: Omit<Parameters<typeof createApplication>[0], 'directory'>,
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'terrain-testing-backend-'));
  const app = await createApplication({ directory, ...options });
  const project = await app.store.save({
    ...newProject(),
    scene: { ...newProject().scene, rooms: [makeRoom({ id: 'hall' })] },
  });
  const server = app.app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await rm(directory, { recursive: true, force: true });
  });
  const http = async (route: string, body?: unknown) => {
    const r = await fetch(origin + route, {
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    return { status: r.status, body: await r.json() };
  };
  return { ...app, directory, project, origin, http };
}
function turn(name: string, args: unknown): ModelTurn {
  return {
    calls: [{ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
    content: null,
    usage: { inputTokens: 12, outputTokens: 8, cost: null },
    truncated: false,
  };
}

test('testing switches default voice off and validate backend/model without changing Gateway defaults', () => {
  assert.deepEqual(resolveTestingBackend({}), {
    designBackend: 'gateway',
    codexModel: 'gpt-6.1-sol',
    codexBinary: 'codex',
    voiceEnabled: false,
  });
  assert.equal(resolveTestingBackend({ VOICE_ENABLED: 'true' }).voiceEnabled, true);
  assert.throws(() => resolveTestingBackend({ DESIGN_BACKEND: 'unknown' }));
  assert.throws(() => resolveTestingBackend({ CODEX_MODEL: 'model; command' }));
});

test('disabled voice blocks both endpoints before any provider call or usage charge', async (t) => {
  let calls = 0;
  const app = await fixture(t, {
    env: { AI_GATEWAY_API_KEY: 'synthetic-only' },
    audioFetcher: async () => {
      calls++;
      throw Error('must not call');
    },
  });
  const before = await app.store.read();
  const speech = await app.http('/api/speak', { text: 'Do not speak.' });
  assert.equal(speech.status, 409);
  const r = await fetch(app.origin + '/api/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'audio/webm' },
    body: Buffer.alloc(1000),
  });
  assert.equal(r.status, 409);
  const status = (await app.http('/api/status')).body;
  assert.equal(status.voiceEnabled, false);
  assert.equal(status.voiceConnected, false);
  assert.equal(status.usage.requests, 0);
  assert.equal(calls, 0);
  assert.deepEqual(await app.store.read(), before);
});

test('Codex routing needs no Gateway key, keeps models separate and does not charge Gateway accounting', async (t) => {
  const turns = [
    turn('apply_operations', {
      operations: [{ type: 'set_material', palette: 'cedar', roomIds: ['hall'] }],
    }),
    turn('finish_design', { mode: 'propose', reply: 'Cedar proposal.' }),
  ];
  const client: AgentModel = {
    async complete() {
      return turns.shift()!;
    },
  };
  let probes = 0;
  const app = await fixture(t, {
    env: { DESIGN_BACKEND: 'codex-cli', AI_GATEWAY_MODEL: 'anthropic/claude-sonnet-5.5' },
    codexClient: client,
    codexStatus: async () => {
      probes++;
      return { connected: true };
    },
  });
  const status = (await app.http('/api/status')).body;
  assert.equal(status.designBackend, 'codex-cli');
  assert.equal(status.model, 'gpt-6.1-sol');
  assert.equal(status.gatewayModel, 'anthropic/claude-sonnet-5.5');
  assert.equal(status.gatewayConnected, false);
  assert.equal(status.modelConnected, true);
  const response = await app.http('/api/agent', {
    projectId: app.project.projectId,
    baseRevision: app.project.revision,
    scene: app.project.scene,
    messages: [{ id: 'owner', role: 'user', text: 'Use cedar in the hall.' }],
    context: { allowVisualReview: false },
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.usage.calls, 2);
  assert.equal(response.body.usage.cost, null);
  assert.equal((await app.http('/api/status')).body.usage.requests, 0);
  assert.equal((await app.http('/api/status')).body.usage.modelCost, 0);
  assert.equal(probes, 1);
  assert.deepEqual(await app.store.read(), app.project);
});

test('unavailable Codex fails closed for build and alternatives even with a Gateway key', async (t) => {
  let calls = 0;
  const app = await fixture(t, {
    env: { DESIGN_BACKEND: 'codex-cli', AI_GATEWAY_API_KEY: 'must-not-fallback' },
    codexClient: {
      async complete() {
        calls++;
        throw Error('must not call');
      },
    },
    codexStatus: async () => ({ connected: false, reason: 'signed out' }),
  });
  const status = (await app.http('/api/status')).body;
  assert.equal(status.gatewayConnected, true);
  assert.equal(status.modelConnected, false);
  for (const route of ['/api/agent', '/api/alternatives/generate']) {
    const result = await app.http(route, {});
    assert.equal(result.status, 428);
    assert.match(result.body.error, /No Gateway fallback/);
  }
  assert.equal(calls, 0);
  assert.equal((await app.http('/api/status')).body.usage.requests, 0);
  assert.deepEqual(await app.store.read(), app.project);
});

test('Codex selector persists, preserves Gateway settings, and routes new runs to the selected model and effort', async (t) => {
  const routed: Array<{ model: string; reasoningEffort: string }> = [];
  const app = await fixture(t, {
    env: { DESIGN_BACKEND: 'codex-cli', CODEX_MODEL: 'gpt-6.1-sol' },
    codexStatus: async () => ({ connected: true }),
    codexClientFactory: (options) => {
      routed.push({ model: options.model, reasoningEffort: options.reasoningEffort });
      return {
        async complete() {
          return turn('finish_design', { mode: 'question', reply: 'Which style do you prefer?' });
        },
      };
    },
  });
  const save = async (body: unknown) => {
    const r = await fetch(app.origin + '/api/connections', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  assert.equal(
    (await save({ gatewayKey: 'synthetic-only', model: 'anthropic/claude-sonnet-5.5' })).status,
    200,
  );
  const switched = await save({ codexModel: 'gpt-6-astra' });
  assert.equal(switched.status, 200);
  assert.equal(switched.body.codexModel, 'gpt-6-astra');
  const status = (await app.http('/api/status')).body;
  assert.equal(status.model, 'gpt-6-astra');
  assert.equal(status.reasoningEffort, 'high');
  assert.equal(status.gatewayModel, 'anthropic/claude-sonnet-5.5');
  assert.equal(status.keySource, 'saved');
  assert.equal(status.voiceEnabled, false);
  const restored = await createApplication({
    directory: app.directory,
    env: { DESIGN_BACKEND: 'codex-cli', CODEX_MODEL: 'gpt-6.1-sol' },
    codexStatus: async () => ({ connected: true }),
  });
  const restoredServer = restored.app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => restoredServer.once('listening', r));
  try {
    const recovered = await (
      await fetch(`http://127.0.0.1:${(restoredServer.address() as AddressInfo).port}/api/status`)
    ).json();
    assert.equal(
      recovered.model,
      'gpt-6-astra',
      'saved selection overrides the environment starting default',
    );
    assert.equal(recovered.reasoningEffort, 'high');
  } finally {
    await new Promise<void>((r) => restoredServer.close(() => r()));
  }
  for (const model of ['gpt-6-astra', 'gpt-6.1-sol']) {
    assert.equal((await save({ codexModel: model })).status, 200);
    const r = await app.http('/api/agent', {
      projectId: app.project.projectId,
      baseRevision: app.project.revision,
      scene: app.project.scene,
      messages: [{ id: 'owner', role: 'user', text: 'Help me choose a style.' }],
      context: { allowVisualReview: false },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // Diagnostic persistence completes after the HTTP response is sent.
    let log: any;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        log = JSON.parse(
          await readFile(path.join(app.directory, 'runs', `${r.body.runId}.json`), 'utf8'),
        );
        break;
      } catch (error) {
        if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT')
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assert.ok(log, 'completed run diagnostic was persisted');
    assert.equal(log.model, model);
  }
  assert.deepEqual(routed, [
    { model: 'gpt-6-astra', reasoningEffort: 'high' },
    { model: 'gpt-6.1-sol', reasoningEffort: 'medium' },
  ]);
  assert.equal((await save({ codexModel: 'unknown' })).status, 400);
  assert.equal((await app.http('/api/status')).body.model, 'gpt-6.1-sol');
  assert.equal((await app.http('/api/status')).body.usage.requests, 0);
  assert.deepEqual(await app.store.read(), app.project);
});

test('Codex selection rejects changes while a design is running and keeps that run on its original model', async (t) => {
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const app = await fixture(t, {
    env: { DESIGN_BACKEND: 'codex-cli', CODEX_MODEL: 'gpt-6-astra' },
    codexStatus: async () => ({ connected: true }),
    codexClientFactory: (options) => {
      assert.equal(options.model, 'gpt-6-astra');
      assert.equal(options.reasoningEffort, 'high');
      return {
        async complete() {
          entered();
          await pending;
          return turn('finish_design', { mode: 'question', reply: 'Which style?' });
        },
      };
    },
  });
  const running = app.http('/api/agent', {
    messages: [{ id: 'owner', role: 'user', text: 'Help me choose.' }],
    projectId: app.project.projectId,
    baseRevision: app.project.revision,
    scene: app.project.scene,
  });
  await Promise.race([
    ready,
    running.then((r) => {
      throw Error(`Run did not reach model: ${JSON.stringify(r)}`);
    }),
  ]);
  try {
    const r = await fetch(app.origin + '/api/connections', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codexModel: 'gpt-6.1-sol' }),
    });
    assert.equal(r.status, 409);
    assert.equal((await app.http('/api/status')).body.model, 'gpt-6-astra');
  } finally {
    release();
  }
  assert.equal((await running).status, 200);
  assert.deepEqual(await app.store.read(), app.project);
});

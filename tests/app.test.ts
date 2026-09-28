import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../server/app.ts';
import type { AgentModel, ModelTurn } from '../server/agent.ts';
import { emptyScene, makeRoom, newProject } from '../shared/model.ts';

const scene = {
  ...emptyScene,
  rooms: [makeRoom({ id: 'kitchen', name: 'Kitchen', kind: 'kitchen' })],
};
const messages = [{ id: 'user', role: 'user', text: 'Use cedar in the kitchen.' }];
function modelTurn(name: string, args: unknown): ModelTurn {
  return {
    calls: [{ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
    content: null,
    usage: { inputTokens: 50, outputTokens: 20, cost: 0.001 },
    truncated: false,
  };
}
const edit = () =>
  modelTurn('apply_operations', {
    operations: [{ type: 'set_material', palette: 'cedar', roomIds: ['kitchen'] }],
  });
const finish = () =>
  modelTurn('finish_design', { mode: 'apply', reply: 'I changed the kitchen to cedar.' });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(t: TestContext, modelClient?: AgentModel) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'terrain-http-'));
  const application = await createApplication({
    directory,
    env: { AI_GATEWAY_API_KEY: 'test-only' },
    modelClient,
  });
  const project = await application.store.save({ ...newProject(), scene });
  const server = application.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  });
  async function request(route: string, method = 'GET', body?: unknown) {
    const response = await fetch(url + route, {
      method,
      ...(body !== undefined
        ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
    });
    return { status: response.status, body: await response.json() };
  }
  return { ...application, project, request };
}

test('HTTP control surface uses the same transactional and revision rules', async (t) => {
  const { request, project } = await fixture(t);
  const capabilities = await request('/api/design/capabilities');
  assert.equal(capabilities.status, 200);
  assert.equal(capabilities.body.version, 1);
  assert.equal(capabilities.body.operationSchema.type, 'array');
  const draft = await request('/api/design/drafts', 'POST', { baseRevision: project.revision });
  assert.equal(draft.status, 200);
  const operation = await request(`/api/design/drafts/${draft.body.id}/operations`, 'POST', {
    operations: [{ type: 'set_material', palette: 'cedar' }],
  });
  assert.equal(operation.status, 200);
  assert.equal(operation.body.ready, true);
  assert.equal((await request('/api/project')).body.scene.palette, 'limestone');
  const rejected = await request(`/api/design/drafts/${draft.body.id}/commit`, 'POST', {
    expectedRevision: project.revision - 1,
  });
  assert.equal(rejected.status, 409);
  const committed = await request(`/api/design/drafts/${draft.body.id}/commit`, 'POST', {
    expectedRevision: project.revision,
  });
  assert.equal(committed.status, 200);
  assert.equal(committed.body.project.scene.palette, 'cedar');
  assert.equal(committed.body.project.past.length, 1);
  assert.equal(committed.body.project.revision, project.revision + 1);
  const duplicate = await request(`/api/design/drafts/${draft.body.id}/commit`, 'POST', {
    expectedRevision: project.revision,
  });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.project.revision, committed.body.project.revision);
  const status = await request('/api/status');
  assert.equal(status.body.usage.requests, 0, 'local control operations incur no cloud calls');
  assert.equal(
    JSON.stringify(status.body).includes('test-only'),
    false,
    'credentials are not returned',
  );
});

test('HTTP agent run exposes a validated preview, then waits for a separate commit', async (t) => {
  const awaitingFinish = deferred<void>();
  const finishTurn = deferred<ModelTurn>();
  let calls = 0;
  const modelClient: AgentModel = {
    async complete() {
      calls++;
      if (calls === 1) return edit();
      awaitingFinish.resolve();
      return finishTurn.promise;
    },
  };
  const { request, project, store } = await fixture(t, modelClient);
  const runId = randomUUID();
  const pending = request('/api/agent', 'POST', {
    runId,
    baseRevision: project.revision,
    scene: project.scene,
    messages,
    context: { selectedRoomId: 'kitchen', view: 'plan' },
  });
  await awaitingFinish.promise;
  const progress = await request(`/api/agent/runs/${runId}`);
  assert.equal(progress.status, 200);
  assert.equal(progress.body.status, 'running');
  assert.equal(progress.body.preview.rooms[0].palette, 'cedar');
  assert.deepEqual(await store.read(), project);
  const concurrent = await request('/api/agent', 'POST', {
    baseRevision: project.revision,
    scene: project.scene,
    messages,
  });
  assert.equal(concurrent.status, 409);
  finishTurn.resolve(finish());
  const result = await pending;
  assert.equal(result.status, 200);
  assert.ok(result.body.draftId);
  assert.equal(result.body.runId, runId);
  assert.equal(result.body.scene.rooms[0].palette, 'cedar');
  assert.equal(result.body.usage.calls, 2);
  assert.deepEqual(await store.read(), project, 'finished agent drafts are still unsaved');
  assert.equal((await request(`/api/agent/runs/${runId}`)).body.status, 'succeeded');
  const duplicateRun = await request('/api/agent', 'POST', {
    runId,
    baseRevision: project.revision,
    scene: project.scene,
    messages,
  });
  assert.equal(duplicateRun.status, 409);
  const commit = await request(`/api/design/drafts/${result.body.draftId}/commit`, 'POST', {
    expectedRevision: project.revision,
  });
  assert.equal(commit.status, 200);
  assert.equal(commit.body.project.scene.rooms[0].palette, 'cedar');
  assert.equal(commit.body.project.past.length, 1);
  assert.equal((await request('/api/status')).body.usage.requests, 2);
});

test('HTTP cancellation aborts the active model and discards the uncommitted draft', async (t) => {
  const entered = deferred<void>();
  const modelClient: AgentModel = {
    async complete(_history, signal) {
      assert.ok(signal);
      entered.resolve();
      return new Promise<ModelTurn>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    },
  };
  const { request, project, store } = await fixture(t, modelClient);
  const runId = randomUUID();
  const pending = request('/api/agent', 'POST', {
    runId,
    baseRevision: project.revision,
    scene: project.scene,
    messages,
  });
  await entered.promise;
  assert.equal((await request(`/api/agent/runs/${runId}/cancel`, 'POST', {})).status, 200);
  const cancelled = await pending;
  assert.equal(cancelled.status, 422);
  assert.match(cancelled.body.error, /cancelled/);
  const progress = await request(`/api/agent/runs/${runId}`);
  assert.equal(progress.body.status, 'cancelled');
  assert.equal(progress.body.preview, null);
  assert.deepEqual(await store.read(), project);
});

test('daily cloud limits apply to each harness round and leave no partially saved edit', async (t) => {
  let calls = 0;
  const modelClient: AgentModel = {
    async complete() {
      calls++;
      return edit();
    },
  };
  const { request, project, store } = await fixture(t, modelClient);
  assert.equal((await request('/api/connections', 'PUT', { dailyLimit: 1 })).status, 200);
  const runId = randomUUID();
  const result = await request('/api/agent', 'POST', {
    runId,
    baseRevision: project.revision,
    scene: project.scene,
    messages,
  });
  assert.equal(result.status, 429);
  assert.match(result.body.error, /Daily cloud request limit/);
  assert.equal(calls, 1);
  assert.equal((await request('/api/status')).body.usage.requests, 1);
  const progress = await request(`/api/agent/runs/${runId}`);
  assert.equal(progress.body.status, 'failed');
  assert.equal(progress.body.preview, null);
  assert.deepEqual(await store.read(), project);
});

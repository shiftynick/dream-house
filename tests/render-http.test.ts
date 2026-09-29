import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../server/app.ts';
import { emptyScene, makeRoom } from '../shared/model.ts';
import { renderCamera, renderRequestSchema, type RenderJob } from '../shared/render.ts';
import type { RenderBroker } from '../server/render-service.ts';

const scene = { ...emptyScene, rooms: [makeRoom({ id: 'living' })] };
const request = renderRequestSchema.parse({ view: 'exterior' });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function capture(job: RenderJob) {
  const { position, target } = renderCamera(job.scene, job.request);
  return {
    image: 'data:image/png;base64,YWJj',
    width: 768,
    height: 576,
    view: job.request.view,
    sceneHash: job.sceneHash,
    camera: { position, target },
  };
}
async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'terrain-render-http-'));
  const application = await createApplication({ directory, env: {} });
  const originalWait = application.renders.waitForJob.bind(application.renders);
  const entered = new Map<string, ReturnType<typeof deferred<AbortSignal>>>();
  application.renders.waitForJob = (...args: Parameters<RenderBroker['waitForJob']>) => {
    const pending = originalWait(...args);
    entered.get(args[0])?.resolve(args[2]!);
    entered.delete(args[0]);
    return pending;
  };
  const server = application.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const clients: string[] = [];
  t.after(async () => {
    for (const client of clients) application.renders.disconnect(client);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  });
  const http = async (route: string, method = 'GET', body?: unknown) => {
    const response = await fetch(origin + route, {
      method,
      ...(body
        ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  const register = async () => {
    const response = await http('/api/render/clients', 'POST');
    assert.equal(response.status, 200);
    clients.push(response.body.clientId);
    return response.body.clientId as string;
  };
  const wait = (clientId: string, afterId?: string) => {
    const gate = deferred<AbortSignal>();
    entered.set(clientId, gate);
    const controller = new AbortController();
    const response = fetch(
      `${origin}/api/render/jobs?wait=1&clientId=${clientId}${afterId ? `&afterId=${afterId}` : ''}`,
      { signal: controller.signal },
    );
    return { response, controller, started: gate.promise };
  };
  return { ...application, http, register, wait };
}

test(
  'HTTP long poll wakes for queued captures and completion without waking another renderer',
  { timeout: 5000 },
  async (t) => {
    const app = await fixture(t);
    const client = await app.register(),
      other = await app.register();
    const listening = app.wait(client),
      isolated = app.wait(other);
    await Promise.all([listening.started, isolated.started]);
    let otherWoke = false;
    void isolated.response.then(() => {
      otherWoke = true;
    });
    const pending = app.renders.render(client, scene, request);
    const response = await listening.response;
    assert.equal(response.status, 200);
    const job = (await response.json()).job as RenderJob;
    assert.equal(job.scene.rooms[0].id, 'living');
    assert.equal(otherWoke, false);
    const completion = app.wait(client, job.id);
    await completion.started;
    const submitted = await app.http(`/api/render/jobs/${job.id}/result`, 'POST', {
      clientId: client,
      result: capture(job),
    });
    assert.equal(submitted.status, 200);
    assert.equal((await (await completion.response).json()).job, null);
    assert.equal((await pending).sceneHash, job.sceneHash);
    assert.equal(otherWoke, false);
    await app.http(`/api/render/clients/${other}`, 'DELETE');
    assert.equal((await isolated.response).status, 409);
  },
);

test(
  'aborting the HTTP wait releases its waiter without cancelling an active capture or blocking a fresh wait',
  { timeout: 5000 },
  async (t) => {
    const app = await fixture(t);
    const client = await app.register();
    const pending = app.renders.render(client, scene, request);
    const failedCapture = assert.rejects(pending, /Synthetic renderer failure/);
    const job = (await app.http(`/api/render/jobs?clientId=${client}`)).body.job as RenderJob;
    const listening = app.wait(client, job.id);
    const serverSignal = await listening.started;
    const closed = new Promise<void>((resolve) =>
      serverSignal.addEventListener('abort', () => resolve(), { once: true }),
    );
    const aborted = assert.rejects(listening.response, { name: 'AbortError' });
    listening.controller.abort();
    await Promise.all([aborted, closed]);
    assert.equal(app.renders.poll(client).job?.id, job.id);
    const fresh = app.wait(client, job.id);
    await fresh.started;
    const result = await app.http(`/api/render/jobs/${job.id}/result`, 'POST', {
      clientId: client,
      error: 'Synthetic renderer failure',
    });
    assert.equal(result.status, 200);
    const completed = await fresh.response;
    assert.equal(completed.status, 200);
    assert.equal((await completed.json()).job, null);
    await failedCapture;
  },
);

test(
  'duplicate waits and invalid cursors fail without disturbing the original wait; client deletion wakes it',
  { timeout: 5000 },
  async (t) => {
    const app = await fixture(t);
    const client = await app.register();
    const listening = app.wait(client);
    await listening.started;
    const duplicate = await app.http(`/api/render/jobs?clientId=${client}&wait=1`);
    assert.equal(duplicate.status, 409);
    assert.match(duplicate.body.error, /already has an active job wait/);
    const malformed = await app.http(`/api/render/jobs?clientId=${client}&wait=1&afterId=invalid`);
    assert.equal(malformed.status, 400);
    await app.http(`/api/render/clients/${client}`, 'DELETE');
    assert.equal((await listening.response).status, 409);
    assert.equal(app.renders.available(client), false);
    const replacement = await app.register();
    assert.equal((await app.http(`/api/render/jobs?clientId=${replacement}`)).body.job, null);
  },
);

test(
  'cancelling an active capture wakes HTTP wait with the next queued job',
  { timeout: 5000 },
  async (t) => {
    const app = await fixture(t);
    const client = await app.register();
    const abort = new AbortController();
    const first = app.renders.render(client, scene, request, abort.signal);
    const cancelled = assert.rejects(first, /cancelled/);
    const firstJob = app.renders.poll(client).job!;
    const next = app.renders.render(client, scene, renderRequestSchema.parse({ view: 'plan' }));
    const waiting = app.wait(client, firstJob.id);
    await waiting.started;
    abort.abort();
    const response = await waiting.response;
    assert.equal(response.status, 200);
    const nextJob = (await response.json()).job as RenderJob;
    assert.notEqual(nextJob.id, firstJob.id);
    assert.equal(nextJob.request.view, 'plan');
    await app.http(`/api/render/jobs/${nextJob.id}/result`, 'POST', {
      clientId: client,
      result: capture(nextJob),
    });
    assert.equal((await next).view, 'plan');
    await cancelled;
  },
);

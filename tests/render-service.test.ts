import test from 'node:test';
import assert from 'node:assert/strict';
import { RenderBroker, RenderUnavailable, sceneFingerprint } from '../server/render-service.ts';
import { emptyScene, makeRoom } from '../shared/model.ts';
import {
  renderCamera,
  renderRequestSchema,
  type RenderCaptureResult,
  type RenderJob,
} from '../shared/render.ts';

const image = 'data:image/png;base64,YWJj';
const scene = () => ({ ...emptyScene, rooms: [makeRoom({ id: 'living', kind: 'living' })] });
const request = () => renderRequestSchema.parse({ view: 'exterior' });
function result(job: RenderJob, overrides: Partial<RenderCaptureResult> = {}): RenderCaptureResult {
  const { position, target } = renderCamera(job.scene, job.request);
  return {
    image,
    width: 800,
    height: 600,
    view: job.request.view,
    sceneHash: job.sceneHash,
    camera: { position, target },
    ...overrides,
  };
}

test('render broker delivers isolated jobs and accepts only the requested scene and view from the owning client', async () => {
  const broker = new RenderBroker();
  const a = broker.register().clientId,
    b = broker.register().clientId;
  const original = scene(),
    saved = structuredClone(original);
  const pending = broker.provider(a)(original, request());
  const job = broker.poll(a).job!;
  original.rooms[0].width = 10;
  assert.deepEqual(job.scene, saved);
  assert.equal(job.sceneHash, sceneFingerprint(saved));
  assert.equal(broker.poll(b).job, null);
  assert.throws(() => broker.submit(job.id, b, result(job)), /different renderer/);
  assert.throws(
    () => broker.submit(job.id, a, result(job, { sceneHash: '0'.repeat(64) })),
    /does not match/,
  );
  assert.throws(() => broker.submit(job.id, a, result(job, { view: 'plan' })), /does not match/);
  assert.equal(broker.poll(a).job?.id, job.id);
  broker.submit(job.id, a, result(job));
  const capture = await pending;
  assert.equal(capture.sceneHash, sceneFingerprint(saved));
  assert.equal(broker.poll(a).job, null);
  assert.throws(() => broker.submit(job.id, a, result(job)), /expired/);
});

test('explicit comparison cameras cannot be replaced by an unrelated returned camera', async () => {
  const broker = new RenderBroker();
  const client = broker.register().clientId;
  const camera = {
    position: [10, 12, 14] as [number, number, number],
    target: [0, 2, 0] as [number, number, number],
  };
  const pending = broker.render(
    client,
    scene(),
    renderRequestSchema.parse({ view: 'exterior', camera }),
  );
  const job = broker.poll(client).job!;
  try {
    assert.throws(
      () =>
        broker.submit(
          job.id,
          client,
          result(job, { camera: { ...camera, position: [30, 12, 14] } }),
        ),
      /camera|match/,
    );
    broker.submit(job.id, client, result(job));
    assert.deepEqual((await pending).camera, camera);
  } finally {
    broker.disconnect(client);
    await pending.catch(() => {});
  }
});

test('cancellation and disconnection reject pending captures without affecting another renderer', async () => {
  const broker = new RenderBroker();
  const client = broker.register().clientId,
    other = broker.register().clientId;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(broker.render(client, scene(), request(), controller.signal), {
    name: 'AbortError',
  });
  assert.equal(broker.poll(client).job, null);
  const active = new AbortController();
  const cancelled = broker.render(client, scene(), request(), active.signal);
  const cancelledAssertion = assert.rejects(cancelled, /cancelled/);
  active.abort();
  await cancelledAssertion;
  assert.equal(broker.poll(client).job, null);
  const disconnected = broker.render(client, scene(), request());
  const disconnectedAssertion = assert.rejects(disconnected, /disconnected/);
  const unaffected = broker.render(other, scene(), request());
  broker.disconnect(client);
  await disconnectedAssertion;
  const otherJob = broker.poll(other).job!;
  broker.submit(otherJob.id, other, result(otherJob));
  assert.equal((await unaffected).view, 'exterior');
  assert.equal(broker.available(client), false);
});

test('expired heartbeats and capture deadlines free queued jobs', async () => {
  let now = 0;
  const broker = new RenderBroker(60_000, () => now);
  const client = broker.register().clientId;
  const pending = broker.render(client, scene(), request());
  const expired = assert.rejects(pending, /disconnected/);
  now = 15_001;
  assert.equal(broker.available(client), false);
  await expired;
  assert.throws(() => broker.poll(client), RenderUnavailable);
  const timeoutBroker = new RenderBroker(5);
  const timeoutClient = timeoutBroker.register().clientId;
  await assert.rejects(timeoutBroker.render(timeoutClient, scene(), request()), /timed out/);
  assert.equal(timeoutBroker.poll(timeoutClient).job, null);
});

test('invalid capture data can be corrected, and nonexistent rooms never enqueue a capture', async () => {
  const broker = new RenderBroker();
  const client = broker.register().clientId;
  await assert.rejects(
    broker.render(
      client,
      scene(),
      renderRequestSchema.parse({ view: 'interior', roomId: 'missing' }),
    ),
    /not in this draft/,
  );
  assert.equal(broker.poll(client).job, null);
  const pending = broker.render(client, scene(), request());
  const job = broker.poll(client).job!;
  assert.throws(() =>
    broker.submit(job.id, client, result(job, { image: 'https://example.com/render.png' })),
  );
  assert.throws(() => broker.submit(job.id, client, result(job, { width: 0 })));
  broker.submit(job.id, client, result(job));
  assert.equal((await pending).image, image);
});

test('browser error responses release their capture job, and polling refreshes only that client heartbeat', async () => {
  let now = 0;
  const broker = new RenderBroker(60_000, () => now);
  const active = broker.register().clientId,
    idle = broker.register().clientId;
  const pending = broker.render(active, scene(), request());
  const rejected = assert.rejects(pending, /GPU context was lost/);
  const job = broker.poll(active).job!;
  now = 14_000;
  assert.equal(broker.poll(active).job?.id, job.id);
  now = 28_000;
  assert.equal(broker.available(active), true);
  assert.equal(broker.available(idle), false);
  broker.submit(job.id, active, undefined, 'GPU context was lost');
  await rejected;
  assert.equal(broker.poll(active).job, null);
});

test('long waits wake for new jobs and completion, keep leases alive and isolate other clients', async () => {
  let now = 0;
  const broker = new RenderBroker(60_000, () => now);
  const client = broker.register().clientId;
  const other = broker.register().clientId;
  const listening = broker.waitForJob(client);
  let otherWoke = false;
  const stopOther = new AbortController();
  const otherWait = broker.waitForJob(other, undefined, stopOther.signal).then(
    () => {
      otherWoke = true;
    },
    () => {},
  );
  const pending = broker.render(client, scene(), request());
  const job = (await listening).job!;
  assert.ok(job);
  assert.equal(otherWoke, false);
  now = 9000;
  const completion = broker.waitForJob(client, job.id);
  broker.submit(job.id, client, result(job));
  assert.equal((await completion).job, null);
  await pending;
  now = 18_000;
  assert.equal(broker.available(client), true);
  stopOther.abort();
  await otherWait;
});

test('cancelled, duplicate and disconnected waits release resources without orphaning jobs', async () => {
  const broker = new RenderBroker();
  const client = broker.register().clientId;
  const abort = new AbortController();
  const wait = broker.waitForJob(client, undefined, abort.signal);
  const cancelled = assert.rejects(wait, { name: 'AbortError' });
  await assert.rejects(broker.waitForJob(client), /already has/);
  abort.abort();
  await cancelled;
  assert.equal((await broker.waitForJob(client, undefined, undefined, 2)).job, null);
  const disconnected = broker.waitForJob(client);
  const rejected = assert.rejects(disconnected, RenderUnavailable);
  broker.disconnect(client);
  await rejected;
  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(broker.waitForJob(client, undefined, preAborted.signal), {
    name: 'AbortError',
  });
});

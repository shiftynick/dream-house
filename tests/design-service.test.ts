import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DesignService, DesignServiceError } from '../server/design-service.ts';
import { ProjectStore, RevisionConflict } from '../server/storage.ts';
import { emptyScene, makeRoom, newProject, type Scene } from '../shared/model.ts';

function house(): Scene {
  return {
    ...emptyScene,
    rooms: [
      makeRoom({ id: 'kitchen', name: 'Kitchen', kind: 'kitchen', width: 4, depth: 4 }),
      makeRoom({ id: 'living', name: 'Living room', kind: 'living', x: 8, width: 4, depth: 4 }),
    ],
  };
}
async function fixture(t: TestContext, scene = house()) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'terrain-design-service-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ProjectStore(directory);
  const project = await store.save({ ...newProject(), scene });
  const service = new DesignService(store);
  return { directory, store, project, service };
}
const cedar = [{ type: 'set_material', palette: 'cedar' }];

test('multiple draft operations do not touch storage and commit as one undoable edit', async (t) => {
  const { directory, store, service, project } = await fixture(t);
  const originalFile = await readFile(path.join(directory, 'project.json'), 'utf8');
  const entry = await service.create(project.revision, project.scene);
  service.apply(entry.id, cedar);
  service.apply(entry.id, [
    { type: 'update_room', roomId: 'kitchen', patch: { name: 'Garden kitchen' } },
  ]);
  assert.deepEqual(await store.read(), project);
  assert.equal(await readFile(path.join(directory, 'project.json'), 'utf8'), originalFile);
  assert.equal(service.describe(entry.id).ready, true);
  const result = await service.commit(entry.id, project.revision, false);
  assert.equal(result.project.scene.palette, 'cedar');
  assert.equal(result.project.scene.rooms[0].name, 'Garden kitchen');
  assert.deepEqual(result.project.past, [project.scene]);
  assert.equal(result.project.future.length, 0);
  assert.equal(result.project.revision, project.revision + 1);
  assert.equal(result.project.messages.length, 1);
  assert.deepEqual(await store.read(), result.project);
});

test('commit retries and concurrent duplicate requests create one revision and undo entry', async (t) => {
  const { service, project, store } = await fixture(t);
  const entry = await service.create(project.revision);
  service.apply(entry.id, cedar);
  const [first, duplicate] = await Promise.all([
    service.commit(entry.id, project.revision, false),
    service.commit(entry.id, project.revision, false),
  ]);
  assert.deepEqual(duplicate.project, first.project);
  const retry = await service.commit(entry.id, project.revision, false);
  assert.equal(retry.project.revision, project.revision + 1);
  assert.equal(retry.project.past.length, 1);
  assert.equal(retry.project.messages.length, 1);
  assert.deepEqual(await store.read(), first.project);
});

test('a commit retry returns the latest project without reapplying an old edit', async (t) => {
  const { service, project, store } = await fixture(t);
  const entry = await service.create(project.revision);
  service.apply(entry.id, cedar);
  const committed = await service.commit(entry.id, project.revision, false);
  const next = await store.update(committed.project.revision, (current) => ({
    ...current,
    scene: { ...current.scene, palette: 'chalk' },
  }));
  const retry = await service.commit(entry.id, project.revision, false);
  assert.equal(retry.project.scene.palette, 'chalk');
  assert.equal(retry.project.revision, next.revision);
  assert.equal(retry.project.past.length, 1);
});

test('destructive changes and explicit proposals cannot commit without confirmation', async (t) => {
  for (const destructive of [true, false]) {
    const { service, project, store } = await fixture(t);
    const entry = await service.create(project.revision);
    service.apply(entry.id, destructive ? [{ type: 'remove_objects', ids: ['kitchen'] }] : cedar);
    if (!destructive) entry.needsConfirmation = true;
    await assert.rejects(
      service.commit(entry.id, project.revision, false),
      (error) =>
        error instanceof DesignServiceError &&
        error.status === 409 &&
        /confirmation/.test(error.message),
    );
    assert.deepEqual(await store.read(), project);
    const committed = await service.commit(entry.id, project.revision, true);
    assert.equal(committed.project.scene.rooms.length, destructive ? 1 : 2);
    assert.equal(committed.project.past.length, 1);
  }
});

test('confirmed brief changes require review independently of model intent', async (t) => {
  const scene = house();
  scene.design = {
    groups: [],
    connections: [],
    stairLinks: [],
    requirements: [
      {
        id: 'brief',
        kind: 'intent',
        description: 'Keep the living room bright.',
        source: 'confirmed',
      },
    ],
  };
  const { service, project, store } = await fixture(t, scene);
  const entry = await service.create(project.revision);
  service.apply(entry.id, [{ type: 'remove_requirement', requirementId: 'brief' }]);
  assert.equal(service.describe(entry.id).needsConfirmation, true);
  await assert.rejects(service.commit(entry.id, project.revision, false), /confirmation/);
  assert.deepEqual(await store.read(), project);
});

test('invalid geometry remains repairable but cannot be committed', async (t) => {
  const { service, project, store } = await fixture(t);
  const entry = await service.create(project.revision);
  const invalid = service.apply(entry.id, [
    { type: 'resize_room', roomId: 'kitchen', width: 18, anchor: 'center', moveConnected: false },
  ]);
  assert.equal(invalid.ready, false);
  assert.ok(invalid.issues.some((issue) => issue.severity === 'error'));
  await assert.rejects(
    service.commit(entry.id, project.revision, true),
    /unresolved design issues/,
  );
  assert.deepEqual(await store.read(), project);
  const repaired = service.apply(entry.id, [
    { type: 'resize_room', roomId: 'kitchen', width: 6, anchor: 'center', moveConnected: false },
  ]);
  assert.equal(repaired.ready, true);
  const committed = await service.commit(entry.id, project.revision, false);
  assert.equal(committed.project.scene.rooms[0].width, 6);
  assert.equal(committed.project.past.length, 1);
});

test('failed operation batches never commit earlier operations from the same batch', async (t) => {
  const { service, project, store } = await fixture(t);
  const entry = await service.create(project.revision);
  const failed = service.apply(entry.id, [
    ...cedar,
    { type: 'update_room', roomId: 'missing-room', patch: { name: 'Missing' } },
  ]);
  assert.equal(failed.ready, false);
  assert.equal(failed.scene.palette, project.scene.palette);
  await assert.rejects(service.commit(entry.id, project.revision, true), /unresolved/);
  assert.deepEqual(await store.read(), project);
});

test('draft creation and commits reject stale project state', async (t) => {
  const { service, project, store } = await fixture(t);
  await assert.rejects(service.create(project.revision - 1), RevisionConflict);
  await assert.rejects(
    service.create(project.revision, { ...project.scene, palette: 'chalk' }),
    RevisionConflict,
  );
  const first = await service.create(project.revision);
  const stale = await service.create(project.revision);
  service.apply(first.id, cedar);
  service.apply(stale.id, [{ type: 'set_material', palette: 'charcoal' }]);
  const committed = await service.commit(first.id, project.revision, false);
  await assert.rejects(service.commit(stale.id, project.revision, false), RevisionConflict);
  // Even a caller providing the newest revision must not overwrite a scene the
  // draft was never based on.
  await assert.rejects(
    service.commit(stale.id, committed.project.revision, false),
    RevisionConflict,
  );
  assert.equal((await store.read()).scene.palette, 'cedar');
  assert.equal((await store.read()).past.length, 1);
});

test('message-only saves can advance a revision without invalidating the scene draft', async (t) => {
  const { service, project, store } = await fixture(t);
  const entry = await service.create(project.revision);
  service.apply(entry.id, cedar);
  const withMessage = await store.update(project.revision, (current) => ({
    ...current,
    messages: [{ id: 'user', role: 'user', text: 'Use cedar.' }],
  }));
  await assert.rejects(service.commit(entry.id, project.revision, false), RevisionConflict);
  const committed = await service.commit(entry.id, withMessage.revision, false);
  assert.equal(committed.project.scene.palette, 'cedar');
  assert.equal(committed.project.messages[0].text, 'Use cedar.');
  assert.equal(committed.project.messages.length, 2);
  assert.equal(committed.project.past.length, 1);
});

test('expired or discarded drafts leave the project unchanged', async (t) => {
  const { service, project, store } = await fixture(t);
  const discarded = await service.create(project.revision);
  service.apply(discarded.id, cedar);
  service.discard(discarded.id);
  await assert.rejects(
    service.commit(discarded.id, project.revision, true),
    (error) => error instanceof DesignServiceError && error.status === 404,
  );
  const expired = await service.create(project.revision);
  expired.createdAt = Date.now() - 31 * 60_000;
  assert.throws(
    () => service.get(expired.id),
    (error) => error instanceof DesignServiceError && error.status === 404,
  );
  assert.deepEqual(await store.read(), project);
});

test('no-op commands do not add an undo entry or invent a material change', async (t) => {
  const { service, project } = await fixture(t);
  const entry = await service.create(project.revision);
  const noOp = service.apply(entry.id, [{ type: 'set_material', palette: 'limestone' }]);
  assert.deepEqual(noOp.changes, []);
  const committed = await service.commit(entry.id, project.revision, false);
  assert.deepEqual(committed.project.scene, project.scene);
  assert.equal(committed.project.past.length, 0);
  assert.equal(committed.reply, 'No changes were needed.');
});

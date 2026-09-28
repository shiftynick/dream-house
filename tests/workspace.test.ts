import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ProjectStore, RevisionConflict } from '../server/storage.ts';
import { emptyScene, makeRoom, newProject } from '../shared/model.ts';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'terrain-workspace-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, store: new ProjectStore(directory) };
}

test('legacy migration is lazy, preserves original bytes, and retains all house history and conversation', async (t) => {
  const { directory, store } = await fixture(t);
  const scene = {
    ...emptyScene,
    name: 'Existing hillside house',
    rooms: [makeRoom({ id: 'living' })],
  };
  const legacy = {
    ...newProject(),
    revision: 7,
    scene,
    past: [emptyScene],
    future: [{ ...scene, palette: 'cedar' }],
    variants: [{ id: 'older', name: 'First thought', createdAt: '2026-09-28', scene }],
    messages: [{ id: 'u', role: 'user', text: 'Keep the fireplace centered.' }],
  };
  const bytes = JSON.stringify(legacy, null, 2) + '\n';
  await writeFile(path.join(directory, 'project.json'), bytes);
  const read = await store.read();
  assert.equal(read.projectId, 'original');
  assert.equal(read.projectName, scene.name);
  assert.deepEqual(
    { ...read, projectId: undefined, projectName: undefined },
    { ...legacy, projectId: undefined, projectName: undefined },
  );
  await store.list();
  assert.deepEqual(await readdir(directory), ['project.json']);
  assert.equal(await readFile(path.join(directory, 'project.json'), 'utf8'), bytes);
  const saved = await store.update(
    read.revision,
    (project) => ({ ...project, projectName: 'Hillside design' }),
    read.projectId,
  );
  assert.equal(saved.revision, 8);
  assert.equal(await readFile(path.join(directory, 'project.json'), 'utf8'), bytes);
  const workspace = JSON.parse(await readFile(path.join(directory, 'workspace.json'), 'utf8'));
  assert.equal(workspace.activeProjectId, 'original');
  assert.deepEqual(workspace.projects, [saved]);
  assert.deepEqual(await new ProjectStore(directory).read(), saved);
});

test('new houses isolate geometry, brief, chat and undo history; reopening restores the complete previous project', async (t) => {
  const { store, directory } = await fixture(t);
  const first = await store.save({
    ...newProject(),
    scene: {
      ...emptyScene,
      name: 'First home',
      rooms: [makeRoom({ id: 'living' })],
      design: {
        groups: [],
        connections: [],
        stairLinks: [],
        requirements: [
          {
            id: 'brief',
            kind: 'intent',
            source: 'confirmed',
            description: 'A warm stone exterior.',
          },
        ],
      },
    },
    past: [emptyScene],
    future: [emptyScene],
    variants: [{ id: 'v1', name: 'Earlier', createdAt: '2026-09-28', scene: emptyScene }],
    messages: [{ id: 'u', role: 'user', text: 'First house conversation.' }],
  });
  const second = await store.createProject('  Garden house  ', first.projectId!, first.revision);
  assert.notEqual(second.projectId, first.projectId);
  assert.equal(second.projectName, 'Garden house');
  assert.equal(second.scene.name, 'Garden house');
  assert.equal(second.revision, 0);
  assert.deepEqual(second.scene.rooms, []);
  assert.equal(second.scene.design, undefined);
  assert.deepEqual(
    [second.messages, second.past, second.future, second.variants],
    [[], [], [], []],
  );
  const changedSecond = await store.update(
    second.revision,
    (current) => ({
      ...current,
      messages: [{ id: 'u2', role: 'user', text: 'Second house conversation.' }],
      scene: { ...current.scene, rooms: [makeRoom({ id: 'garden' })] },
    }),
    second.projectId,
  );
  const reopened = await store.openProject(
    first.projectId!,
    changedSecond.projectId!,
    changedSecond.revision,
  );
  assert.deepEqual(reopened, first);
  const library = await store.list();
  assert.equal(library.activeProjectId, first.projectId);
  assert.equal(library.projects.length, 2);
  assert.equal(library.projects.find((item) => item.id === second.projectId)?.rooms, 1);
  assert.deepEqual(await new ProjectStore(directory).read(), first);
  const secondAgain = await store.openProject(second.projectId!, first.projectId!, first.revision);
  assert.deepEqual(secondAgain, changedSecond);
});

test('project IDs protect saves and transitions even when two houses share the same revision', async (t) => {
  const { store } = await fixture(t);
  const first = await store.read();
  const second = await store.createProject('Another house', first.projectId!, first.revision);
  assert.equal(first.revision, second.revision);
  await assert.rejects(
    store.save({ ...first, scene: { ...first.scene, palette: 'cedar' } }, first.revision),
    RevisionConflict,
  );
  await assert.rejects(
    store.update(
      second.revision,
      (current) => ({ ...current, scene: { ...current.scene, palette: 'cedar' } }),
      first.projectId,
    ),
    RevisionConflict,
  );
  await assert.rejects(
    store.openProject(first.projectId!, first.projectId!, first.revision),
    RevisionConflict,
  );
  await assert.rejects(
    store.createProject('Stale new house', first.projectId!, first.revision),
    RevisionConflict,
  );
  await assert.rejects(
    store.openProject('missing', second.projectId!, second.revision),
    /no longer/,
  );
  assert.deepEqual(await store.read(), second);
  const outcomes = await Promise.allSettled([
    store.update(
      second.revision,
      (current) => ({ ...current, projectName: 'Winner A' }),
      second.projectId,
    ),
    store.update(
      second.revision,
      (current) => ({ ...current, projectName: 'Winner B' }),
      second.projectId,
    ),
  ]);
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
  const failed = outcomes.find((result) => result.status === 'rejected');
  assert.ok(failed?.status === 'rejected' && failed.reason instanceof RevisionConflict);
  assert.equal((await store.read()).revision, second.revision + 1);
});

test('failed atomic workspace writes preserve the saved project and active house and do not poison later saves', async (t) => {
  const { store, directory } = await fixture(t);
  const saved = await store.save(newProject());
  const original = await readFile(path.join(directory, 'workspace.json'), 'utf8');
  const obstruction = path.join(directory, 'workspace.json.tmp');
  await mkdir(obstruction);
  await assert.rejects(
    store.update(
      saved.revision,
      (current) => ({ ...current, projectName: 'Must not persist' }),
      saved.projectId,
    ),
  );
  await assert.rejects(store.createProject('Must not appear', saved.projectId!, saved.revision));
  assert.deepEqual(await store.read(), saved);
  assert.equal((await store.list()).projects.length, 1);
  assert.equal(await readFile(path.join(directory, 'workspace.json'), 'utf8'), original);
  await rm(obstruction, { recursive: true });
  const recovered = await store.update(
    saved.revision,
    (current) => ({ ...current, projectName: 'Recovered' }),
    saved.projectId,
  );
  assert.equal(recovered.revision, saved.revision + 1);
  assert.equal((await store.read()).projectName, 'Recovered');
});

test('a corrupt library never silently falls back to an older legacy house', async (t) => {
  const { directory, store } = await fixture(t);
  await writeFile(path.join(directory, 'project.json'), JSON.stringify(newProject()));
  await writeFile(path.join(directory, 'workspace.json'), '{broken');
  await assert.rejects(store.read());
  assert.equal(await readFile(path.join(directory, 'workspace.json'), 'utf8'), '{broken');
});

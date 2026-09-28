import assert from 'node:assert/strict';
import test from 'node:test';
import { newProject, type Project } from '../shared/model.ts';
import { ApiError } from '../src/api.ts';
import { ProjectPersistence } from '../src/projectPersistence.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const rename = (name: string) => (project: Project | null) => ({
  ...project!,
  scene: { ...project!.scene, name },
});

test('save queue preserves edits made during a request and flush waits for their acknowledged revision', async () => {
  const requests: { project: Project; pending: ReturnType<typeof deferred<Project>> }[] = [];
  const seenNames: string[] = [];
  const controller = new ProjectPersistence(
    (project) => {
      const pending = deferred<Project>();
      requests.push({ project, pending });
      return pending.promise;
    },
    (project) => {
      if (project) seenNames.push(project.scene.name);
    },
    () => {},
  );
  controller.acceptPersisted({ ...newProject(), revision: 7 });
  controller.edit(rename('First local edit'));
  const flushing = controller.flush();
  assert.equal(controller.flush(), flushing, 'parallel callers join the same flush');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].project.revision, 7);
  controller.edit(rename('Newer local edit'));
  const afterNewerEdit = seenNames.length;
  assert.throws(() => controller.acceptPersisted(newProject()), /saving to finish/);
  requests[0].pending.resolve({ ...requests[0].project, revision: 8 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 2);
  assert.equal(requests[1].project.revision, 8);
  assert.equal(requests[1].project.scene.name, 'Newer local edit');
  assert.ok(seenNames.slice(afterNewerEdit).every((name) => name === 'Newer local edit'));
  requests[1].pending.resolve({ ...requests[1].project, revision: 9 });
  const saved = await flushing;
  assert.equal(saved?.revision, 9);
  assert.equal(saved?.scene.name, 'Newer local edit');
  assert.equal(controller.state, 'saved');
  assert.equal(controller.unsaved, false);
});

test('server draft commits are accepted without autosave write-back and become the next CAS revision', async () => {
  const writes: Project[] = [];
  const controller = new ProjectPersistence(
    async (project) => {
      writes.push(project);
      return { ...project, revision: project.revision + 1 };
    },
    () => {},
    () => {},
  );
  controller.acceptPersisted(newProject());
  await controller.flush();
  controller.acceptPersisted({ ...newProject(), revision: 14 });
  await controller.flush();
  assert.equal(writes.length, 0);
  controller.edit(rename('After agent commit'));
  await controller.flush();
  assert.equal(writes[0].revision, 14);
  assert.equal(controller.project?.revision, 15);
});

test('revision conflicts retain local work and stop all further writes until an explicit reload', async () => {
  let calls = 0;
  const errors: string[] = [];
  const controller = new ProjectPersistence(
    async () => {
      calls++;
      throw new ApiError('Revision conflict', 409);
    },
    () => {},
    (error) => errors.push(error),
  );
  controller.acceptPersisted({ ...newProject(), revision: 4 });
  controller.edit(rename('Keep this unsaved idea'));
  await assert.rejects(controller.flush(), /Revision conflict/);
  controller.edit(rename('Still my local idea'));
  await assert.rejects(controller.flush(), /Reload the saved project/);
  assert.equal(calls, 1);
  assert.equal(controller.state, 'conflict');
  assert.equal(controller.unsaved, true);
  assert.equal(controller.project?.scene.name, 'Still my local idea');
  assert.match(errors[0], /Export your local work/);
  controller.acceptPersisted({ ...newProject(), revision: 5 });
  assert.equal(controller.state, 'saved');
  assert.equal(controller.unsaved, false);
});

test('failed saves can be retried without advancing the acknowledged revision or dropping local messages', async () => {
  let attempts = 0;
  const revisions: number[] = [];
  const controller = new ProjectPersistence(
    async (project) => {
      attempts++;
      revisions.push(project.revision);
      if (attempts === 1) throw new ApiError('Temporary disk failure', 500);
      return { ...project, revision: project.revision + 1 };
    },
    () => {},
    () => {},
  );
  controller.acceptPersisted({ ...newProject(), revision: 3 });
  controller.edit((project) => ({
    ...project!,
    messages: [
      {
        id: 'failure',
        role: 'assistant',
        kind: 'error',
        text: 'Design failed.',
        retryText: 'Attach the bedroom.',
      },
    ],
  }));
  await assert.rejects(controller.flush(), /Temporary disk failure/);
  assert.equal(controller.state, 'error');
  const saved = await controller.flush();
  assert.deepEqual(revisions, [3, 3]);
  assert.equal(saved?.messages[0].retryText, 'Attach the bedroom.');
  assert.equal(controller.unsaved, false);
});

test('an explicit stale-draft conflict protects the current local project before any further save', async () => {
  let writes = 0;
  const controller = new ProjectPersistence(
    async (project) => {
      writes++;
      return project;
    },
    () => {},
    () => {},
  );
  controller.acceptPersisted({ ...newProject(), revision: 8 });
  controller.markConflict();
  assert.equal(controller.state, 'conflict');
  await assert.rejects(controller.flush(), /Reload the saved project/);
  assert.equal(writes, 0);
  assert.equal(controller.project?.revision, 8);
  const conflict = new ApiError('The draft is stale.', 409, 'revision_conflict');
  assert.equal(conflict.code, 'revision_conflict');
  assert.equal(new ApiError('Another run is busy.', 409).code, undefined);
});

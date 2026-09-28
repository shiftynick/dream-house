import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  editProject,
  newProject,
  redo,
  sampleScene,
  undo,
  validateScene,
} from '../shared/model.ts';
import { ProjectStore } from '../server/storage.ts';
import { runAgent } from '../server/agent.ts';

test('new projects start empty; undo, redo, and branching preserve the previous design', () => {
  const initial = newProject();
  assert.equal(initial.scene.rooms.length, 0);
  const first = editProject(initial, sampleScene());
  const changed = editProject(first, { ...first.scene, palette: 'cedar' });
  assert.equal(undo(changed).scene.palette, 'limestone');
  assert.equal(redo(undo(changed)).scene.palette, 'cedar');
  const branched = editProject(undo(changed), { ...first.scene, roof: 'pitched' });
  assert.equal(branched.future.length, 0);
  assert.equal(branched.scene.roof, 'pitched');
  assert.equal(first.scene.roof, 'flat');
  assert.deepEqual(undo(first).scene, initial.scene);
});
test('invalid geometry and duplicate object IDs are rejected before changing the scene', () => {
  const scene = sampleScene();
  assert.throws(() => validateScene({ ...scene, rooms: [{ ...scene.rooms[0], width: -2 }] }));
  assert.throws(
    () => validateScene({ ...scene, rooms: [scene.rooms[0], scene.rooms[0]] }),
    /unique/,
  );
  assert.throws(() => validateScene({ ...scene, rooms: [{ ...scene.rooms[0], x: Infinity }] }));
  assert.throws(
    () =>
      validateScene({
        ...scene,
        rooms: [scene.rooms[0], { ...scene.rooms[0], id: 'overlap', x: 1 }],
      }),
    /overlap/,
  );
  assert.doesNotThrow(() =>
    validateScene({
      ...scene,
      rooms: [scene.rooms[0], { ...scene.rooms[0], id: 'upper', elevation: scene.rooms[0].height }],
    }),
  );
  const p = editProject(newProject(), scene);
  assert.throws(() => editProject(p, { ...scene, slope: 2 }));
  assert.equal(p.scene.slope, 0.16);
});
test('local storage serializes writes and preserves the last valid project if a save fails', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'terrain-test-'));
  try {
    const store = new ProjectStore(directory);
    assert.equal((await store.read()).scene.rooms.length, 0);
    const first = editProject(newProject(), sampleScene());
    const second = editProject(first, { ...first.scene, palette: 'charcoal' });
    await Promise.all([store.save(first), store.save(second)]);
    assert.equal((await store.read()).scene.palette, 'charcoal');
    assert.throws(() =>
      store.save({
        ...second,
        scene: { ...second.scene, rooms: [{ ...second.scene.rooms[0], depth: 0 }] },
      }),
    );
    assert.equal((await store.read()).scene.palette, 'charcoal');
    assert.equal(
      JSON.parse(await readFile(path.join(directory, 'project.json'), 'utf8')).version,
      1,
    );
    await writeFile(path.join(directory, 'project.json'), 'corrupt');
    await assert.rejects(store.read());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('agent sends a bounded scene context and validates returned edits', async () => {
  let body: any;
  const scene = sampleScene();
  const fetcher = (async (_url: unknown, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    return Response.json({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              reply: 'I changed the exterior to cedar.',
              needsConfirmation: false,
              scene: { ...scene, palette: 'cedar' },
            }),
          },
        },
      ],
      usage: { prompt_tokens: 500, completion_tokens: 400, cost: 0.0005 },
    });
  }) as typeof fetch;
  const result = await runAgent({
    key: 'test-only',
    model: 'test-model',
    scene,
    messages: Array.from({ length: 15 }, (_, i) => ({
      id: String(i),
      role: 'user',
      text: 'Use cedar',
    })),
    fetcher,
  });
  assert.equal(result.scene?.palette, 'cedar');
  assert.equal(body.messages.length, 12);
  assert.equal(body.provider.require_parameters, true);
  assert.equal(body.response_format.json_schema.strict, true);
  assert.equal(result.usage.cost, 0.0005);
  assert.equal(scene.palette, 'limestone');
});
test('agent rejects truncated, malformed, or invalid geometry without automatic paid retries', async () => {
  for (const response of [
    { choices: [{ finish_reason: 'length', message: { content: '{"scene":' } }] },
    { choices: [{ finish_reason: 'stop', message: { content: 'not JSON' } }] },
    {
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              reply: 'Done',
              needsConfirmation: false,
              scene: { ...sampleScene(), slope: 50 },
            }),
          },
        },
      ],
    },
  ]) {
    let calls = 0;
    const scene = sampleScene();
    await assert.rejects(
      runAgent({
        key: 'test-only',
        model: 'test-model',
        scene,
        messages: [{ id: '1', role: 'user', text: 'Change it' }],
        fetcher: (async () => {
          calls++;
          return Response.json(response);
        }) as typeof fetch,
      }),
    );
    assert.equal(calls, 1);
    assert.equal(scene.slope, 0.16);
  }
});
test('major changes remain proposals, while clarification leaves geometry alone', async () => {
  for (const result of [
    {
      reply: 'Would you like to replace the layout?',
      needsConfirmation: true,
      scene: sampleScene(),
    },
    { reply: 'Which side should the kitchen be on?', needsConfirmation: false, scene: null },
  ]) {
    const returned = await runAgent({
      key: 'test-only',
      model: 'test-model',
      scene: newProject().scene,
      messages: [{ id: '1', role: 'user', text: 'Change it' }],
      fetcher: (async () =>
        Response.json({
          choices: [{ message: { content: JSON.stringify(result) } }],
        })) as typeof fetch,
    });
    assert.equal(returned.needsConfirmation, result.needsConfirmation);
    assert.deepEqual(returned.scene, result.scene);
  }
});

test('substantial deletion always requires review even when the model forgets to ask', async () => {
  const result = await runAgent({
    key: 'test-only',
    model: 'test-model',
    scene: sampleScene(),
    messages: [{ id: '1', role: 'user', text: 'Make it simpler' }],
    fetcher: (async () =>
      Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                reply: 'Here is a smaller direction.',
                needsConfirmation: false,
                scene: newProject().scene,
              }),
            },
          },
        ],
      })) as typeof fetch,
  });
  assert.equal(result.needsConfirmation, true);
});

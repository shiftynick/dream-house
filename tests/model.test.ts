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
import { gatewayAgentModel } from '../server/agent.ts';
import { GatewayError } from '../server/gateway.ts';

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
      JSON.parse(await readFile(path.join(directory, 'workspace.json'), 'utf8')).version,
      1,
    );
    await writeFile(path.join(directory, 'workspace.json'), 'corrupt');
    await assert.rejects(store.read());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('agent gateway adapter sends documented tool contracts and preserves usage', async () => {
  const signal = new AbortController().signal;
  let requests = 0;
  const client = gatewayAgentModel('test-only', 'anthropic/claude-sonnet-5.5', (async (
    url,
    init,
  ) => {
    requests++;
    assert.equal(url, 'https://ai-gateway.vercel.sh/v1/chat/completions');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-only');
    assert.equal(init?.signal, signal);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'anthropic/claude-sonnet-5.5');
    assert.equal(body.provider, undefined);
    assert.equal(body.response_format, undefined);
    assert.equal(body.tool_choice, 'required');
    assert.equal(body.parallel_tool_calls, false);
    assert.ok(body.max_tokens > 0 && body.max_tokens <= 6000);
    assert.deepEqual(
      body.tools.map((tool: { function: { name: string } }) => tool.function.name).sort(),
      [
        'apply_operations',
        'finish_design',
        'inspect_design',
        'render_view',
        'reset_draft',
        'review_design',
      ],
    );
    assert.ok(
      body.tools.every(
        (tool: { function: { parameters: { type: string } } }) =>
          tool.function.parameters.type === 'object',
      ),
    );
    return Response.json({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            content: null,
            tool_calls: [
              {
                id: 'done',
                type: 'function',
                function: {
                  name: 'finish_design',
                  arguments: JSON.stringify({ mode: 'question', reply: 'Which room?' }),
                },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 500, completion_tokens: 40, cost: 0.0005 },
    });
  }) as typeof fetch);
  const result = await client.complete([{ role: 'user', content: 'Make it bigger' }], signal);
  assert.equal(requests, 1);
  assert.equal(result.calls[0].function.name, 'finish_design');
  assert.equal(result.usage.cost, 0.0005);
  assert.equal(result.usage.inputTokens, 500);
  assert.equal(result.usage.outputTokens, 40);
  assert.equal(result.truncated, false);
});

test('agent gateway adapter rejects provider failures without retries or secret leakage', async () => {
  let calls = 0;
  const client = gatewayAgentModel('test-secret', 'test/model', (async () => {
    calls++;
    return Response.json({ error: 'test-secret' }, { status: 429 });
  }) as typeof fetch);
  await assert.rejects(client.complete([]), (error) => {
    assert.ok(error instanceof GatewayError);
    assert.doesNotMatch(error.message, /test-secret/);
    assert.match(error.message, /429/);
    return true;
  });
  assert.equal(calls, 1);
});

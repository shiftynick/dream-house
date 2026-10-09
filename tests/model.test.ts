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
import { designCritiqueSchema, critiqueObjectiveError } from '../server/design-planning.ts';
import { designAssessmentSchema } from '../shared/assessment.ts';

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
    assert.deepEqual(body.reasoning, { effort: 'medium' });
    assert.equal(body.provider, undefined);
    assert.equal(body.response_format, undefined);
    assert.equal(body.tool_choice, 'required');
    assert.equal(body.parallel_tool_calls, false);
    assert.ok(body.max_tokens > 0 && body.max_tokens <= 6000);
    assert.deepEqual(
      body.tools.map((tool: { function: { name: string } }) => tool.function.name).sort(),
      [
        'apply_operations',
        'compose_house',
        'critique_design',
        'finish_design',
        'inspect_design',
        'plan_design',
        'render_planned_views',
        'render_view',
        'reset_draft',
        'resume_editing',
        'review_design',
      ],
    );
    assert.ok(
      body.tools.every(
        (tool: { function: { parameters: { type: string } } }) =>
          tool.function.parameters.type === 'object',
      ),
    );
    for (const tool of body.tools) {
      for (const combinator of ['oneOf', 'anyOf', 'allOf']) {
        assert.equal(
          combinator in tool.function.parameters,
          false,
          `${tool.function.name} must publish an object-only schema root`,
        );
      }
    }
    const review = body.tools.find((tool: any) => tool.function.name === 'review_design').function
      .parameters;
    assert.equal(review.properties.assessment.const, 'canonical');
    assert.equal(review.properties.requirements.type, 'array');
    assert.equal(review.properties.assumptions.type, 'array');
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

test('Sonnet 5.5 uses low adaptive effort for critics and medium for builders without changing other model requests', async () => {
  const cases = [
    { model: 'anthropic/claude-sonnet-5.5', toolNames: ['submit_design_critique'], effort: 'low' },
    { model: 'anthropic/claude-sonnet-5.5', toolNames: undefined, effort: 'medium' },
    { model: 'anthropic/claude-sonnet-5.5', toolNames: ['finish_design'], effort: 'medium' },
    { model: 'anthropic/claude-sonnet-5.5', toolNames: ['apply_operations'], effort: 'medium' },
    {
      model: 'anthropic/claude-sonnet-5.5',
      toolNames: ['submit_design_critique', 'apply_operations'],
      effort: 'medium',
    },
    {
      model: 'anthropic/claude-sonnet-4.5',
      toolNames: ['submit_design_critique'],
      effort: undefined,
    },
    { model: 'test/model', toolNames: ['submit_design_critique'], effort: undefined },
  ];
  for (const item of cases) {
    let requests = 0;
    const client = gatewayAgentModel('test-only', item.model, (async (_url, init) => {
      requests++;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.max_tokens, 6000);
      assert.equal(body.temperature, 0.2);
      assert.equal(body.tool_choice, 'required');
      assert.equal(body.parallel_tool_calls, false);
      assert.deepEqual(body.reasoning, item.effort ? { effort: item.effort } : undefined);
      assert.equal(body.reasoning_effort, undefined);
      assert.equal(body.thinking, undefined);
      if (item.effort === 'low')
        assert.deepEqual(
          body.tools.map((tool: any) => tool.function.name),
          ['submit_design_critique'],
        );
      return Response.json({
        choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [] } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 },
      });
    }) as typeof fetch);
    await client.complete(
      [{ role: 'user', content: 'Review the supplied draft.' }],
      undefined,
      item.toolNames,
    );
    assert.equal(requests, 1);
  }
});

test('critic manifest constrains provider observations and complete responses pass the actual objective gate', async () => {
  const ids = ['plan-intent', ...Array.from({ length: 7 }, (_, index) => `required-${index}`)];
  const objectives = designAssessmentSchema.parse({
    requirements: ids.map((id) => ({
      id,
      request: `Complete ${id}`,
      status: 'unverified',
      evidence: 'Declared objective.',
    })),
  });
  const submission = {
    intentReview: { status: 'adequate', evidence: 'Reviewed the complete request.' },
    observations: ids.map((objectiveId) => ({
      objectiveId,
      status: 'satisfactory',
      evidence: 'Checked the current evidence.',
    })),
  };
  const client = gatewayAgentModel('test-only', 'anthropic/claude-sonnet-5.5', (async (
    _url,
    init,
  ) => {
    const body = JSON.parse(String(init?.body));
    const observations = body.tools[0].function.parameters.properties.observations;
    assert.equal(observations.minItems, ids.length);
    assert.equal(observations.maxItems, ids.length);
    assert.deepEqual(observations.items.properties.objectiveId.enum, ids);
    assert.deepEqual(body.reasoning, { effort: 'low' });
    assert.equal(body.max_tokens, 6000);
    return Response.json({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            content: null,
            tool_calls: [
              {
                id: 'critique',
                type: 'function',
                function: { name: 'submit_design_critique', arguments: JSON.stringify(submission) },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 },
    });
  }) as typeof fetch);
  const response = await client.complete([], undefined, ['submit_design_critique'], ids);
  const accepted = designCritiqueSchema.parse(JSON.parse(response.calls[0].function.arguments));
  assert.equal(critiqueObjectiveError(objectives, accepted), undefined);
  const incomplete = designCritiqueSchema.parse({
    ...submission,
    observations: submission.observations.slice(0, 1),
  });
  assert.match(
    critiqueObjectiveError(objectives, incomplete)!,
    /every immutable planned objective/,
  );
  const duplicated = designCritiqueSchema.parse({
    ...submission,
    observations: ids.map(() => submission.observations[0]),
  });
  assert.match(
    critiqueObjectiveError(objectives, duplicated)!,
    /every immutable planned objective/,
  );
});

test('critic schema falls back safely without a valid bounded manifest and never constrains builder calls', async () => {
  for (const ids of [
    undefined,
    [],
    ['same', 'same'],
    [''],
    ['x'.repeat(61)],
    Array.from({ length: 13 }, (_, index) => `item-${index}`),
  ]) {
    const client = gatewayAgentModel('test-only', 'anthropic/claude-sonnet-5.5', (async (
      _url,
      init,
    ) => {
      const observations = JSON.parse(String(init?.body)).tools[0].function.parameters.properties
        .observations;
      assert.equal(observations.minItems, 1);
      assert.equal(observations.maxItems, 12);
      assert.equal(observations.items.properties.objectiveId.enum, undefined);
      return Response.json({
        choices: [{ finish_reason: 'stop', message: { content: null } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 },
      });
    }) as typeof fetch);
    await client.complete([], undefined, ['submit_design_critique'], ids);
  }
  const client = gatewayAgentModel('test-only', 'anthropic/claude-sonnet-5.5', (async (
    _url,
    init,
  ) => {
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.reasoning, { effort: 'medium' });
    assert.equal(
      body.tools.some((tool: any) => tool.function.name === 'submit_design_critique'),
      false,
    );
    return Response.json({
      choices: [{ finish_reason: 'stop', message: { content: null } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 },
    });
  }) as typeof fetch);
  await client.complete([], undefined, undefined, ['plan-intent']);
});

test('provider phase projections omit repeated checklist schemas while preserving default contracts', async () => {
  let defaultFinishSize = 0;
  let projectedFinishSize = 0;
  for (const phase of [undefined, 'empty-site', 'composition-review'] as const) {
    const client = gatewayAgentModel('test-only', 'test/model', (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const finish = body.tools.find((tool: any) => tool.function.name === 'finish_design').function
        .parameters;
      const review = body.tools.find((tool: any) => tool.function.name === 'review_design')
        ?.function.parameters;
      assert.equal(finish.type, 'object');
      assert.equal(finish.additionalProperties, false);
      for (const key of ['anyOf', 'oneOf', 'allOf']) assert.equal(key in finish, false);
      if (!phase) {
        defaultFinishSize = JSON.stringify(finish).length;
        assert.ok(finish.properties.assessment.anyOf);
        assert.ok(review.properties.requirements);
      } else if (phase === 'empty-site') {
        assert.equal(finish.properties.mode.const, 'question');
        assert.equal(finish.properties.questionReason.const, 'clarification');
        assert.equal(finish.properties.assessment, undefined);
        assert.equal(finish.properties.visualReview, undefined);
      } else {
        projectedFinishSize = JSON.stringify(finish).length;
        assert.equal(finish.properties.assessment.const, 'canonical');
        assert.equal(review.properties.assessment.const, 'canonical');
        assert.equal(review.properties.requirements, undefined);
        assert.ok(finish.properties.visualReview);
      }
      return Response.json({
        choices: [{ finish_reason: 'stop', message: { content: null } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 },
      });
    }) as typeof fetch);
    await client.complete([], undefined, undefined, undefined, phase);
  }
  assert.ok(projectedFinishSize < defaultFinishSize / 4);
});

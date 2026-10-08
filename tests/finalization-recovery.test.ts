import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, type ModelTurn } from '../server/agent.ts';
import { emptyScene, makeRoom } from '../shared/model.ts';

const scene = { ...emptyScene, rooms: [makeRoom({ id: 'hall', width: 8, depth: 6 })] };
const messages = [{ id: 'owner', role: 'user' as const, text: 'Use cedar for the house.' }];
const checklist = {
  requirements: [
    {
      id: 'materials',
      request: 'Use cedar.',
      priority: 'required',
      status: 'fulfilled',
      evidence: 'Locally checked.',
      checks: [{ kind: 'material', roomId: 'hall', palette: 'cedar' }],
    },
  ],
  assumptions: [{ description: 'Use cedar throughout.', requiresConfirmation: true }],
};
function turn(name: string, args: unknown): ModelTurn {
  return {
    content: null,
    truncated: false,
    usage: { inputTokens: 1, outputTokens: 1, cost: 0 },
    calls: [{ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  };
}
const paint = () =>
  turn('apply_operations', { operations: [{ type: 'set_material', palette: 'cedar' }] });
const finish = (assessment: unknown = checklist) =>
  turn('finish_design', { mode: 'propose', reply: 'The cedar draft is ready.', assessment });

test('review and finish schema errors do not consume geometry repair allowance and expose safe diagnostic paths', async () => {
  const turns = [
    paint(),
    turn('review_design', { requirements: [] }),
    turn('finish_design', { mode: 'propose', reply: '' }),
    finish(),
  ];
  const result = await runAgent({
    scene,
    messages,
    maxRepairs: 0,
    context: { allowVisualReview: false },
    client: {
      async complete() {
        return turns.shift()!;
      },
    },
  });
  const diagnostics = result.events.filter((event) =>
    event.issues?.some((issue) => issue.code === 'invalid_tool_arguments'),
  );
  assert.equal(diagnostics.length, 2);
  assert.ok(diagnostics.every((event) => event.stage === 'checking'));
  assert.ok(diagnostics.some((event) => JSON.stringify(event.issues).includes('reply')));
  assert.ok(diagnostics.every((event) => !JSON.stringify(event).includes('Locally checked.')));
  assert.equal(result.scene?.rooms.length, 1);
});

test('canonical finalization preserves reviewed immutable checks and consequential assumptions', async () => {
  const turns = [
    paint(),
    turn('review_design', checklist),
    turn('review_design', { assessment: 'canonical' }),
    finish('canonical'),
  ];
  const result = await runAgent({
    scene,
    messages,
    maxRepairs: 0,
    context: { allowVisualReview: false },
    client: {
      async complete() {
        return turns.shift()!;
      },
    },
  });
  assert.deepEqual(result.assessment?.requirements[0].checks, checklist.requirements[0].checks);
  assert.deepEqual(result.assessment?.assumptions, checklist.assumptions);
  assert.equal(result.assessment?.requiresConfirmation, true);
});

test('canonical checklist is rechecked against changed geometry', async () => {
  const turns = [
    paint(),
    turn('review_design', checklist),
    turn('apply_operations', { operations: [{ type: 'set_material', palette: 'charcoal' }] }),
    finish('canonical'),
  ];
  const result = await runAgent({
    scene,
    messages,
    context: { allowVisualReview: false },
    client: {
      async complete() {
        return turns.shift()!;
      },
    },
  });
  assert.notEqual(result.assessment?.requirements[0].status, 'fulfilled');
  assert.equal(result.needsConfirmation, true);
});

test('schema-only retries remain bounded by consecutive idle rounds', async () => {
  let calls = 0;
  await assert.rejects(
    runAgent({
      scene,
      messages,
      maxRepairs: 0,
      context: { allowVisualReview: false },
      client: {
        async complete() {
          calls++;
          return turn('finish_design', { reply: '', mode: 'propose' });
        },
      },
    }),
    /stopped making progress/,
  );
  assert.equal(calls, 3);
});

test('invalid mutation arguments still consume geometry repair allowance', async () => {
  await assert.rejects(
    runAgent({
      scene,
      messages,
      maxRepairs: 0,
      context: { allowVisualReview: false },
      client: {
        async complete() {
          return turn('apply_operations', { operations: [{ type: 'unknown' }] });
        },
      },
    }),
    /could not resolve the design conflicts/,
  );
});

test('canonical finalization uses planned objectives without model retranscription', async () => {
  const plan = {
    intent: 'Coordinate the existing hall materials.',
    scope: 'focused',
    roomProgram: [
      { roomId: 'hall', name: 'Hall', kind: scene.rooms[0].kind, purpose: 'Gathering' },
    ],
    features: [{ id: 'cedar', request: 'Use cedar.', checks: checklist.requirements[0].checks }],
    reviewViews: ['exterior'],
    assumptions: checklist.assumptions,
  };
  const turns = [turn('plan_design', plan), paint(), finish('canonical')];
  const result = await runAgent({
    scene,
    messages,
    maxCalls: 3,
    maxRepairs: 0,
    context: { allowVisualReview: false },
    client: {
      async complete() {
        return turns.shift()!;
      },
    },
  });
  const objective = result.assessment?.requirements.find((item) => item.request === 'Use cedar.');
  assert.deepEqual(objective?.checks, checklist.requirements[0].checks);
  assert.equal(result.needsConfirmation, true);
  assert.match(result.reply, /unverified/);
});

test('published object schema does not weaken mutually exclusive review variants', async () => {
  const turns = [
    paint(),
    turn('review_design', checklist),
    turn('review_design', { assessment: 'canonical', ...checklist }),
    finish('canonical'),
  ];
  const result = await runAgent({
    scene,
    messages,
    maxRepairs: 0,
    context: { allowVisualReview: false },
    client: {
      async complete() {
        return turns.shift()!;
      },
    },
  });
  assert.ok(
    result.events.some(
      (event) =>
        event.tool === 'review_design' &&
        event.issues?.some((issue) => issue.code === 'invalid_tool_arguments'),
    ),
  );
  assert.deepEqual(result.assessment?.requirements[0].checks, checklist.requirements[0].checks);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { gatewayAgentModel, runAgent, type ModelTurn, type ModelMessage } from '../server/agent.ts';
import { DesignDraft } from '../shared/draft.ts';
import { emptyScene, makeRoom } from '../shared/model.ts';
import { designPlanSchema } from '../server/design-planning.ts';

const prompt =
  'I would like you to build a grand lodge demonstrating the maximum awesomeness of your capabilities.';
const messages = [{ id: 'request', role: 'user' as const, text: prompt }];
const house = {
  ...emptyScene,
  rooms: [makeRoom({ id: 'hall', name: 'Grand hall', width: 10, depth: 8 })],
};
let callId = 0;
function turn(name: string, args: unknown, truncated = false): ModelTurn {
  return {
    calls: [
      {
        id: `tool-${callId++}`,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
    content: null,
    truncated,
    usage: { inputTokens: 100, outputTokens: truncated ? 6000 : 20, cost: 0.01 },
  };
}
const finish = () =>
  turn('finish_design', { mode: 'propose', reply: 'The grand lodge core is ready.' });
const cedar = () =>
  turn('apply_operations', { operations: [{ type: 'set_material', palette: 'cedar' }] });
const singleRoomPlan = (room: (typeof house.rooms)[number]) =>
  designPlanSchema.parse({
    intent: 'Create the initial requested space.',
    scope: 'focused',
    roomProgram: [
      { roomId: room.id, name: room.name, kind: room.kind, purpose: 'Initial core space' },
    ],
    reviewViews: ['exterior'],
  });
function criticTurn(history: ModelMessage[]) {
  const input = JSON.parse(String(history[1].content));
  return turn('submit_design_critique', {
    intentReview: {
      status: 'unverified',
      evidence: 'Geometry is checked, visual intent remains unverified with images disabled.',
    },
    captureIds: [],
    observations: input.objectives.requirements.map((item: any) => ({
      objectiveId: item.id,
      status: item.id === 'plan-intent' ? 'unverified' : 'satisfactory',
      evidence: 'Checked the current geometry.',
      ...(item.id === 'plan-intent'
        ? { constraint: 'visibility', limitation: 'No images were supplied for visual judgment.' }
        : {}),
    })),
  });
}
function plannedFinish(history: ModelMessage[]) {
  const assessment = history
    .filter((message) => message.role === 'tool')
    .map((message) => JSON.parse(String(message.content)))
    .reverse()
    .find((result) => result.critique)?.critique.assessment;
  return turn('finish_design', {
    mode: 'propose',
    reply: 'The core is ready for review.',
    assessment: {
      requirements: assessment.requirements.map(
        ({ verification: _v, results: _r, ...item }: any) => item,
      ),
      assumptions: assessment.assumptions,
    },
  });
}

test('truncation discards complete-looking calls and prose, preserves the original request, then builds a fresh core', async () => {
  const discarded = turn(
    'apply_operations',
    { operations: [{ type: 'add_rooms', rooms: [makeRoom({ id: 'ghost' })] }] },
    true,
  );
  discarded.content = 'UNEXECUTED_TRUNCATED_PLAN';
  let calls = 0,
    accounted = 0,
    admitted = 0;
  const result = await runAgent({
    scene: emptyScene,
    messages,
    maxCalls: 6,
    beforeModelCall: async () => {
      admitted++;
    },
    onUsage: async () => {
      accounted++;
    },
    client: {
      async complete(history, _signal, tools) {
        calls++;
        if (tools?.includes('submit_design_critique')) return criticTurn(history);
        if (calls === 1) return discarded;
        if (calls === 2) {
          assert.ok(history.some((message) => message.content === prompt));
          assert.match(String(history[1].content), /"rooms":\[\]/);
          assert.match(String(history.at(-1)?.content), /discarded in full/);
          assert.equal(JSON.stringify(history).includes('UNEXECUTED_TRUNCATED_PLAN'), false);
          assert.ok(
            history.every(
              (message) => !message.tool_calls?.some((call) => call.id === discarded.calls[0].id),
            ),
          );
          assert.ok(history.every((message) => message.tool_call_id !== discarded.calls[0].id));
          return turn('plan_design', singleRoomPlan(house.rooms[0]));
        }
        if (calls === 3)
          return turn('apply_operations', {
            operations: [{ type: 'add_rooms', rooms: house.rooms }],
          });
        if (calls === 4) return turn('critique_design', {});
        return plannedFinish(history);
      },
    },
  });
  assert.deepEqual(
    result.scene?.rooms.map((room) => room.id),
    ['hall'],
  );
  assert.equal(result.usage.calls, 6);
  assert.equal(result.usage.outputTokens, 6100);
  assert.equal(result.usage.inputTokens, 600);
  assert.ok(Math.abs(result.usage.cost! - 0.06) < 1e-8);
  assert.equal(admitted, 6);
  assert.equal(accounted, 6);
  assert.equal(result.metrics?.toolCalls, 5);
  assert.equal(emptyScene.rooms.length, 0);
});

test('recovery retains earlier valid draft progress and never executes a truncated reset or finish', async () => {
  let calls = 0;
  const result = await runAgent({
    scene: house,
    messages,
    client: {
      async complete(history) {
        calls++;
        if (calls === 1) return cedar();
        if (calls === 2) {
          const partial = turn('reset_draft', {}, true);
          partial.calls.push(...finish().calls);
          return partial;
        }
        assert.match(String(history[1].content), /"palette":"cedar"/);
        assert.ok(
          !history.some((message) =>
            message.tool_calls?.some((call) => call.function.name === 'reset_draft'),
          ),
        );
        return finish();
      },
    },
  });
  assert.equal(result.scene?.palette, 'cedar');
  assert.equal(house.palette, 'limestone');
  assert.equal(result.metrics?.toolCalls, 2);
});

test('a second truncated response fails after one recovery and accounts both calls', async () => {
  const draft = new DesignDraft(house);
  let calls = 0,
    admitted = 0,
    accounted = 0;
  await assert.rejects(
    runAgent({
      scene: house,
      draft,
      messages,
      beforeModelCall: async () => {
        admitted++;
      },
      onUsage: async () => {
        accounted++;
      },
      client: {
        async complete() {
          calls++;
          return { ...cedar(), truncated: true };
        },
      },
    }),
    /response budget/,
  );
  assert.equal(calls, 2);
  assert.equal(admitted, 2);
  assert.equal(accounted, 2);
  assert.equal(draft.changed, false);
});

test('truncation cannot add a call beyond maxCalls or evade the no-progress limit', async () => {
  for (const stalled of [false, true]) {
    let calls = 0;
    await assert.rejects(
      runAgent({
        scene: house,
        messages,
        maxCalls: stalled ? 8 : 1,
        client: {
          async complete() {
            calls++;
            return stalled && calls < 3
              ? turn('inspect_design', {})
              : { ...cedar(), truncated: true };
          },
        },
      }),
      /response budget/,
    );
    assert.equal(calls, stalled ? 3 : 1);
  }
});

test('abort during truncated-call usage accounting prevents recovery', async () => {
  const controller = new AbortController();
  const draft = new DesignDraft(house);
  let calls = 0;
  await assert.rejects(
    runAgent({
      scene: house,
      draft,
      messages,
      signal: controller.signal,
      onUsage: async () => {
        controller.abort();
      },
      client: {
        async complete() {
          calls++;
          return { ...cedar(), truncated: true };
        },
      },
    }),
    /abort/i,
  );
  assert.equal(calls, 1);
  assert.equal(draft.changed, false);
});

test('recovery does not relax final geometry/request checks', async () => {
  let calls = 0;
  const result = await runAgent({
    scene: house,
    messages,
    client: {
      async complete() {
        calls++;
        if (calls === 1) return { ...cedar(), truncated: true };
        if (calls === 2) return cedar();
        return turn('finish_design', {
          mode: 'apply',
          reply: 'The lodge is ready.',
          assessment: {
            requirements: [
              {
                id: 'pitched',
                request: 'A pitched lodge roof',
                priority: 'required',
                status: 'fulfilled',
                evidence: 'It is pitched.',
                checks: [{ kind: 'roof', roomId: 'hall', style: 'pitched' }],
              },
            ],
          },
        });
      },
    },
  });
  assert.equal(result.needsConfirmation, true);
  assert.equal(result.assessment?.requirements[0].status, 'partial');
});

test('gateway truncation bypasses malformed partial tool envelopes while retaining usage and the fixed cap', async () => {
  let requests = 0;
  const model = gatewayAgentModel('synthetic-key', 'synthetic-model', (async (_url, init) => {
    requests++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.max_tokens, 6000);
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'length',
            message: {
              content: 'Partial plan must not be reused',
              tool_calls: [{ function: { arguments: '{"operations":[' } }],
            },
          },
        ],
        usage: { prompt_tokens: 321, completion_tokens: 6000 },
      }),
      { status: 200 },
    );
  }) as typeof fetch);
  const result = await model.complete([{ role: 'user', content: prompt }] satisfies ModelMessage[]);
  assert.equal(requests, 1);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.calls, []);
  assert.equal(result.content, null);
  assert.equal(result.usage.inputTokens, 321);
  assert.equal(result.usage.outputTokens, 6000);
});

test('immutable starting-room summary survives creation, inspection and truncation recovery', async () => {
  for (const startingScene of [emptyScene, house]) {
    const expected = {
      roomCount: startingScene.rooms.length,
      rooms: startingScene.rooms.map(({ id, name }) => ({ id, name })),
    };
    const newRoom = makeRoom({
      id: 'annex',
      name: 'New dining wing',
      x: expected.roomCount ? 8 : 0,
      width: 6,
      depth: 8,
    });
    let calls = 0;
    const result = await runAgent({
      scene: startingScene,
      messages,
      maxCalls: expected.roomCount ? 12 : 7,
      client: {
        async complete(history, _signal, tools) {
          calls++;
          if (tools?.includes('submit_design_critique')) return criticTurn(history);
          const stage = calls - (expected.roomCount ? 0 : 1);
          const snapshot = String(history[1].content);
          const baseline = snapshot.match(
            /Request starting-room summary \(immutable baseline\):\n([^\n]+)/,
          );
          assert.ok(baseline);
          assert.deepEqual(JSON.parse(baseline[1]), expected);
          if (!expected.roomCount)
            assert.match(snapshot, /began on an empty site.*newly created during this run/);
          if (!expected.roomCount && calls === 1)
            return turn('plan_design', singleRoomPlan(newRoom));
          if (stage === 1) {
            const operations: unknown[] = [
              {
                type: 'add_rooms',
                rooms: [newRoom],
              },
            ];
            if (expected.roomCount)
              operations.push(
                { type: 'connect_rooms', roomAId: 'hall', roomBId: 'annex' },
                {
                  type: 'update_room',
                  roomId: 'hall',
                  patch: { name: 'Renamed grand hall' },
                },
              );
            return turn('apply_operations', { operations });
          }
          const currentSnapshot = snapshot.split('\n')[1];
          assert.match(currentSnapshot, /"id":"annex"/);
          if (expected.roomCount) assert.match(currentSnapshot, /Renamed grand hall/);
          if (stage === 2) return turn('inspect_design', {});
          if (stage === 3) return { ...finish(), truncated: true };
          if (!expected.roomCount && stage === 4) return turn('critique_design', {});
          return expected.roomCount ? finish() : plannedFinish(history);
        },
      },
    });
    assert.equal(calls, expected.roomCount ? 4 : 7);
    assert.equal(result.scene?.rooms.length, expected.roomCount + 1);
    assert.deepEqual(
      startingScene.rooms.map(({ id, name }) => ({ id, name })),
      expected.rooms,
    );
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { gatewayAgentModel, runAgent, type ModelTurn, type ModelMessage } from '../server/agent.ts';
import { DesignDraft } from '../shared/draft.ts';
import { emptyScene, makeRoom } from '../shared/model.ts';

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
    beforeModelCall: async () => {
      admitted++;
    },
    onUsage: async () => {
      accounted++;
    },
    client: {
      async complete(history) {
        calls++;
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
          return turn('apply_operations', {
            operations: [{ type: 'add_rooms', rooms: house.rooms }],
          });
        }
        return finish();
      },
    },
  });
  assert.deepEqual(
    result.scene?.rooms.map((room) => room.id),
    ['hall'],
  );
  assert.equal(result.usage.calls, 3);
  assert.equal(result.usage.outputTokens, 6040);
  assert.equal(result.usage.inputTokens, 300);
  assert.equal(result.usage.cost, 0.03);
  assert.equal(admitted, 3);
  assert.equal(accounted, 3);
  assert.equal(result.metrics?.toolCalls, 2);
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
    let calls = 0;
    const result = await runAgent({
      scene: startingScene,
      messages,
      client: {
        async complete(history) {
          calls++;
          const snapshot = String(history[1].content);
          const baseline = snapshot.match(
            /Request starting-room summary \(immutable baseline\):\n([^\n]+)/,
          );
          assert.ok(baseline);
          assert.deepEqual(JSON.parse(baseline[1]), expected);
          if (!expected.roomCount)
            assert.match(snapshot, /began on an empty site.*newly created during this run/);
          if (calls === 1) {
            const operations: unknown[] = [
              {
                type: 'add_rooms',
                rooms: [
                  makeRoom({
                    id: 'annex',
                    name: 'New dining wing',
                    x: expected.roomCount ? 8 : 0,
                    width: 6,
                    depth: 8,
                  }),
                ],
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
          if (calls === 2) return turn('inspect_design', {});
          if (calls === 3) return { ...finish(), truncated: true };
          return finish();
        },
      },
    });
    assert.equal(calls, 4);
    assert.equal(result.scene?.rooms.length, expected.roomCount + 1);
    assert.deepEqual(
      startingScene.rooms.map(({ id, name }) => ({ id, name })),
      expected.rooms,
    );
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, type ModelTurn, type ModelMessage, type ToolCall } from '../server/agent.ts';
import { DesignDraft } from '../shared/draft.ts';
import { executeCommands } from '../shared/design.ts';
import { emptyScene, makeRoom } from '../shared/model.ts';

let nextId = 0;
const call = (name: string, args: unknown): ToolCall => ({
  id: `failure-${nextId++}`,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});
const turn = (...calls: ToolCall[]): ModelTurn => ({
  calls,
  content: null,
  truncated: false,
  usage: { inputTokens: 10, outputTokens: 20, cost: 0 },
});
const results = (history: ModelMessage[]) =>
  history
    .filter((message) => message.role === 'tool')
    .map((message) => ({ id: message.tool_call_id, ...JSON.parse(String(message.content)) }));
const messages = [
  { id: 'request', role: 'user' as const, text: 'Add a window to the gathering hall.' },
];
const rooms = [
  makeRoom({
    id: 'hall',
    name: 'Hall',
    kind: 'living',
    width: 8,
    depth: 6,
    east: 'solid',
    south: 'solid',
    furniture: [],
  }),
  makeRoom({
    id: 'wing',
    name: 'Wing',
    kind: 'bedroom',
    x: 6,
    width: 4,
    depth: 6,
    east: 'solid',
    south: 'solid',
    furniture: [],
  }),
];
const connected = () => {
  const result = executeCommands({ ...emptyScene, rooms }, [
    { type: 'connect_rooms', roomAId: 'hall', roomBId: 'wing', connectionId: 'passage' },
  ]);
  assert.ok(result.applied);
  return result.scene;
};
const windows = (
  side: 'east' | 'north',
  openings = [
    {
      id: 'hall-window',
      kind: 'window',
      offset: 0,
      width: 2,
      height: 2,
      sill: 0.8,
    },
  ],
) =>
  call('apply_operations', {
    operations: [{ type: 'set_wall_openings', roomId: 'hall', side, openings }],
  });
const unrelated = () =>
  call('apply_operations', {
    operations: [
      {
        type: 'set_fireplace',
        fireplace: { x: 0, z: 0, elevation: 0, height: 3 },
      },
    ],
  });
const finish = () =>
  call('finish_design', {
    mode: 'apply',
    reply: 'Added a hall window on its exposed north wall.',
    assessment: {
      requirements: [
        {
          id: 'window',
          request: 'Add a hall window.',
          status: 'fulfilled',
          evidence: 'The north wall contains the new window.',
          checks: [
            {
              kind: 'opening_item',
              roomId: 'hall',
              side: 'north',
              openingId: 'hall-window',
              present: true,
            },
          ],
        },
      ],
    },
  });

test('failed glazing stops stale mutations and finish, pairs every call, then allows next-round repair', async () => {
  const scene = connected();
  const original = structuredClone(scene);
  const draft = new DesignDraft(scene);
  let rounds = 0;
  const first = [windows('east'), unrelated(), call('inspect_design', {}), finish()];
  const result = await runAgent({
    scene,
    draft,
    messages,
    maxRepairs: 1,
    client: {
      async complete(history) {
        if (++rounds === 1) return turn(...first);
        const output = results(history);
        assert.deepEqual(
          output.map((item) => item.id),
          first.map((item) => item.id),
        );
        assert.ok(
          output[0].repair.errors.some(
            (issue: { code: string }) => issue.code === 'opening_overlap',
          ),
        );
        assert.equal(output[0].repair.draftRetained, true);
        assert.ok(
          output[0].quality.rooms
            .find((room: { id: string }) => room.id === 'hall')
            .walls.find((wall: { side: string }) => wall.side === 'north').availableWindowRectangles
            .length,
        );
        for (const index of [1, 3]) {
          assert.equal(output[index].executed, false);
          assert.equal(output[index].blockedByToolCallId, first[0].id);
        }
        assert.equal(output[2].ok, true);
        assert.equal(draft.scene.fireplace, null);
        return turn(windows('east', []), windows('north'), finish());
      },
    },
  });
  assert.equal(rounds, 2);
  assert.equal(result.events.filter((event) => event.stage === 'repairing').length, 1);
  assert.equal(result.scene?.fireplace, null);
  assert.ok(!result.issues.some((issue) => issue.severity === 'error'));
  assert.deepEqual(scene, original, 'saved input is untouched');
  assert.equal(result.usage.cost, 0);
});

test('invalid mutation arguments defer stale work without consuming multiple repair rejections', async () => {
  const scene = connected();
  let rounds = 0;
  const result = await runAgent({
    scene,
    messages,
    maxRepairs: 1,
    client: {
      async complete(history) {
        if (++rounds === 1)
          return turn(
            call('apply_operations', {
              operations: [{ type: 'set_material', palette: 'invented' }],
            }),
            unrelated(),
            unrelated(),
            call('reset_draft', {}),
          );
        assert.equal(results(history).filter((output) => output.executed === false).length, 3);
        return turn(windows('north'), finish());
      },
    },
  });
  assert.equal(rounds, 2);
  assert.equal(result.scene?.fireplace, null);
  assert.equal(result.events.filter((event) => event.stage === 'repairing').length, 1);
});

test('persistent errors consume one rejection per model turn and remain bounded', async () => {
  const scene = connected();
  const draft = new DesignDraft(scene);
  let rounds = 0;
  await assert.rejects(
    runAgent({
      scene,
      draft,
      messages,
      maxRepairs: 2,
      client: {
        async complete() {
          rounds++;
          return turn(windows('east'), unrelated(), unrelated());
        },
      },
    }),
    /could not resolve/,
  );
  assert.equal(rounds, 3);
  assert.equal(draft.scene.fireplace, null);
  assert.ok(draft.issues.some((issue) => issue.severity === 'error'));
  assert.equal(scene.rooms[0].wallOpenings, undefined);
});

test('cancellation after a geometry failure prevents the next model round', async () => {
  const scene = connected();
  const controller = new AbortController();
  let rounds = 0;
  await assert.rejects(
    runAgent({
      scene,
      messages,
      signal: controller.signal,
      onEvent(event) {
        if (event.stage === 'repairing') controller.abort();
      },
      client: {
        async complete() {
          rounds++;
          return turn(windows('east'), unrelated());
        },
      },
    }),
    { name: 'AbortError' },
  );
  assert.equal(rounds, 1);
  assert.equal(scene.fireplace, null);
});

test('deferred stale calls still obey the independent tool-call limit', async () => {
  const scene = connected();
  const draft = new DesignDraft(scene);
  let rounds = 0;
  await assert.rejects(
    runAgent({
      scene,
      draft,
      messages,
      client: {
        async complete() {
          rounds++;
          return turn(windows('east'), ...Array.from({ length: 35 }, unrelated));
        },
      },
    }),
    /tool limit/,
  );
  assert.equal(rounds, 1);
  assert.equal(draft.scene.fireplace, null);
});

test('the completed new-house shell returns final wall slots before any glazing', async () => {
  const controller = new AbortController();
  const draft = new DesignDraft(emptyScene);
  let rounds = 0;
  await assert.rejects(
    runAgent({
      scene: emptyScene,
      draft,
      messages,
      signal: controller.signal,
      client: {
        async complete(history) {
          rounds++;
          if (rounds === 1)
            return turn(
              call('plan_design', {
                intent: 'A connected hall and sleeping wing with real exterior windows.',
                scope: 'composition',
                roomProgram: rooms.map((room) => ({
                  roomId: room.id,
                  name: room.name,
                  kind: room.kind,
                  purpose: room.name,
                })),
                materialStrategy: {
                  description: 'A coherent limestone exterior.',
                  checks: [
                    {
                      kind: 'material_composition',
                      surfaces: ['exterior-walls', 'roof'],
                      allowedPalettes: ['limestone'],
                      maxDistinct: 1,
                    },
                  ],
                },
                fenestration: {
                  description: 'Windows in both occupied rooms.',
                  roomIds: ['hall', 'wing'],
                  minAreaPerRoom: 1,
                },
                reviewViews: ['exterior', 'plan'],
              }),
            );
          if (rounds === 2)
            return turn(
              call('apply_operations', {
                operations: [
                  { type: 'add_rooms', rooms },
                  {
                    type: 'connect_rooms',
                    roomAId: 'hall',
                    roomBId: 'wing',
                    connectionId: 'passage',
                  },
                ],
              }),
            );
          const shell = results(history).at(-1);
          assert.equal(shell.ok, true);
          assert.equal(shell.quality.rooms.length, 2);
          const walls = shell.quality.rooms.find(
            (room: { id: string }) => room.id === 'hall',
          ).walls;
          assert.equal(
            walls.find((wall: { side: string }) => wall.side === 'east').availableWindowRectangles
              .length,
            0,
          );
          assert.ok(
            walls.find((wall: { side: string }) => wall.side === 'north').availableWindowRectangles
              .length,
          );
          assert.match(String(history[1].content), /availableWindowRectangles/);
          controller.abort();
          return turn(call('inspect_design', {}));
        },
      },
    }),
    { name: 'AbortError' },
  );
  assert.equal(rounds, 3);
  assert.equal(emptyScene.rooms.length, 0);
});

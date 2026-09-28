import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentRunError,
  runAgent,
  type AgentModel,
  type ModelMessage,
  type ModelTurn,
  type ToolCall,
} from '../server/agent.ts';
import { DesignDraft } from '../shared/draft.ts';
import { emptyScene, makeRoom, type Scene } from '../shared/model.ts';

const messages = [{ id: 'request', role: 'user' as const, text: 'Make this room larger.' }];
function house(): Scene {
  return {
    ...emptyScene,
    rooms: [
      makeRoom({ id: 'kitchen', name: 'Kitchen', kind: 'kitchen', x: 0, width: 4, depth: 4 }),
      makeRoom({ id: 'living', name: 'Living room', kind: 'living', x: 8, width: 4, depth: 4 }),
    ],
  };
}
function call(name: string, args: unknown, id = name): ToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}
const finish = (mode: 'apply' | 'propose' | 'question' = 'apply') =>
  call('finish_design', {
    mode,
    reply: mode === 'question' ? 'Which room should change?' : 'I updated the selected room.',
  });
function turn(calls: ToolCall[], overrides: Partial<ModelTurn> = {}): ModelTurn {
  return {
    calls,
    content: null,
    usage: { inputTokens: 50, outputTokens: 20, cost: 0.001 },
    truncated: false,
    ...overrides,
  };
}
function script(steps: Array<ModelTurn | ((history: ModelMessage[]) => ModelTurn)>) {
  let calls = 0;
  const histories: ModelMessage[][] = [];
  const client: AgentModel = {
    async complete(history) {
      const snapshot = structuredClone(history);
      histories.push(snapshot);
      const step = steps[calls++];
      assert.ok(step, 'the harness made an unexpected additional model call');
      return typeof step === 'function' ? step(snapshot) : step;
    },
  };
  return {
    client,
    histories,
    get calls() {
      return calls;
    },
  };
}
const toolResults = (history: ModelMessage[]) =>
  history
    .filter((message) => message.role === 'tool')
    .map((message) => JSON.parse(String(message.content)));

test('harness supplies bounded history, selected object, camera and persistent brief', async () => {
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
  const model = script([turn([finish('question')])]);
  const result = await runAgent({
    scene,
    messages: Array.from({ length: 15 }, (_, index) => ({
      id: String(index),
      role: 'user' as const,
      text: `request-${index}`,
    })),
    context: {
      selectedRoomId: 'kitchen',
      view: 'orbit',
      camera: { position: [4, 5, 6], target: [0, 1, 0] },
    },
    client: model.client,
  });
  const history = model.histories[0];
  assert.equal(history.filter((message) => message.role === 'user').length, 10);
  assert.equal(
    history.some((message) => message.content === 'request-0'),
    false,
  );
  assert.equal(
    history.some((message) => message.content === 'request-14'),
    true,
  );
  assert.match(String(history[1].content), /Keep the living room bright/);
  assert.match(String(history[1].content), /"selectedRoomId":"kitchen"/);
  assert.match(String(history[1].content), /"position":\[4,5,6\]/);
  assert.equal(result.scene, null);
  assert.equal(result.needsConfirmation, false);
});

test('geometry conflicts feed a repair loop and only a valid draft is previewed', async () => {
  const scene = house();
  const original = structuredClone(scene);
  const previews: Scene[] = [];
  const model = script([
    turn([
      call('apply_operations', {
        operations: [
          {
            type: 'resize_room',
            roomId: 'kitchen',
            width: 18,
            anchor: 'center',
            moveConnected: false,
          },
        ],
      }),
    ]),
    (history) => {
      const rejected = toolResults(history).at(-1);
      assert.equal(rejected.ok, false);
      assert.ok(
        rejected.issues.some(
          (issue: { severity: string; objectIds: string[] }) =>
            issue.severity === 'error' &&
            issue.objectIds.includes('kitchen') &&
            issue.objectIds.includes('living'),
        ),
      );
      return turn([
        call('apply_operations', {
          operations: [
            {
              type: 'resize_room',
              roomId: 'kitchen',
              width: 6,
              anchor: 'center',
              moveConnected: false,
            },
          ],
        }),
      ]);
    },
    turn([finish()]),
  ]);
  const result = await runAgent({
    scene,
    messages,
    client: model.client,
    onEvent(_event, preview) {
      if (preview) previews.push(preview);
    },
  });
  assert.equal(result.scene?.rooms.find((room) => room.id === 'kitchen')?.width, 6);
  assert.deepEqual(
    result.scene?.rooms.find((room) => room.id === 'living'),
    original.rooms[1],
  );
  assert.equal(
    result.issues.some((issue) => issue.severity === 'error'),
    false,
  );
  assert.ok(result.events.some((event) => event.stage === 'repairing'));
  assert.ok(previews.length > 0);
  assert.ok(previews.every((preview) => preview.rooms[0].width === 6));
  assert.deepEqual(scene, original, 'working drafts never mutate the caller house');
  assert.equal(result.usage.calls, 3);
  assert.equal(result.usage.inputTokens, 150);
  assert.equal(result.usage.outputTokens, 60);
  assert.equal(result.usage.cost, 0.003);
});

test('malformed tool arguments are explained and corrected before any edit', async () => {
  const scene = house();
  const malformed = call('apply_operations', {});
  malformed.function.arguments = '{broken-json';
  const model = script([
    turn([malformed]),
    (history) => {
      assert.match(toolResults(history).at(-1).error, /Invalid tool arguments/);
      return turn([
        call('apply_operations', {
          operations: [{ type: 'set_material', roomIds: ['kitchen'], palette: 'cedar' }],
        }),
      ]);
    },
    turn([finish()]),
  ]);
  const result = await runAgent({ scene, messages, client: model.client });
  assert.equal(result.scene?.rooms[0].palette, 'cedar');
  assert.equal(result.scene?.rooms[1].palette, undefined);
  assert.equal(scene.rooms[0].palette, undefined);
});

test('a false success without actual changes is rejected, including metadata-only no-ops', async () => {
  for (const operations of [null, [{ type: 'set_material', palette: 'limestone' }]]) {
    const model = script([
      ...(operations ? [turn([call('apply_operations', { operations })])] : []),
      turn([finish()]),
      (history) => {
        assert.match(toolResults(history).at(-1).error, /No operations changed/);
        return turn([finish('question')]);
      },
    ]);
    const result = await runAgent({ scene: house(), messages, client: model.client });
    assert.equal(result.scene, null);
    assert.deepEqual(result.changes, []);
  }
});

test('repair allowance and model-call allowance bound unsuccessful loops', async () => {
  let calls = 0;
  const malformed: AgentModel = {
    async complete() {
      calls++;
      return turn([
        call('apply_operations', { operations: [{ type: 'set_material', palette: 'invented' }] }),
      ]);
    },
  };
  await assert.rejects(
    runAgent({ scene: house(), messages, client: malformed, maxRepairs: 1 }),
    /could not resolve/,
  );
  assert.equal(calls, 2, 'one repair round is permitted after the initial failure');
  calls = 0;
  const inspecting: AgentModel = {
    async complete() {
      calls++;
      return turn([call('inspect_design', {})]);
    },
  };
  await assert.rejects(
    runAgent({ scene: house(), messages, client: inspecting, maxCalls: 3 }),
    /model-call limit/,
  );
  assert.equal(calls, 3);
});

test('provider errors, truncation and missing tool calls do not trigger retries', async () => {
  for (const response of [
    new Error('provider unavailable'),
    turn([], { truncated: true }),
    turn([]),
  ]) {
    let calls = 0;
    const client: AgentModel = {
      async complete() {
        calls++;
        if (response instanceof Error) throw response;
        return response;
      },
    };
    await assert.rejects(runAgent({ scene: house(), messages, client }));
    assert.equal(calls, 1);
  }
});

test('cancellation before or during a model call prevents operations', async () => {
  for (const alreadyAborted of [true, false]) {
    const controller = new AbortController();
    const scene = house();
    const draft = new DesignDraft(scene);
    let calls = 0;
    if (alreadyAborted) controller.abort();
    const client: AgentModel = {
      async complete(_history, signal) {
        calls++;
        assert.equal(signal, controller.signal);
        controller.abort();
        return turn([
          call('apply_operations', { operations: [{ type: 'set_material', palette: 'cedar' }] }),
          finish(),
        ]);
      },
    };
    await assert.rejects(
      runAgent({ scene, draft, messages, client, signal: controller.signal }),
      (error) => error instanceof DOMException && error.name === 'AbortError',
    );
    assert.equal(calls, alreadyAborted ? 0 : 1);
    assert.deepEqual(draft.scene, scene);
  }
});

test('unknown selection is rejected before a cloud call', async () => {
  const model = script([]);
  await assert.rejects(
    runAgent({
      scene: house(),
      messages,
      client: model.client,
      context: { selectedRoomId: 'deleted-room' },
    }),
    (error) =>
      error instanceof AgentRunError && /selected room no longer exists/.test(error.message),
  );
  assert.equal(model.calls, 0);
});

test('deletions require confirmation even when the model finishes in apply mode', async () => {
  const scene = house();
  const model = script([
    turn([
      call('apply_operations', { operations: [{ type: 'remove_objects', ids: ['kitchen'] }] }),
    ]),
    turn([finish()]),
  ]);
  const result = await runAgent({ scene, messages, client: model.client });
  assert.equal(result.needsConfirmation, true);
  assert.equal(result.scene?.rooms.length, 1);
  assert.equal(scene.rooms.length, 2);
});

test('model proposals preserve review even for an otherwise modest edit', async () => {
  const model = script([
    turn([call('apply_operations', { operations: [{ type: 'set_material', palette: 'cedar' }] })]),
    turn([finish('propose')]),
  ]);
  const result = await runAgent({ scene: house(), messages, client: model.client });
  assert.equal(result.needsConfirmation, true);
  assert.equal(result.scene?.palette, 'cedar');
});

test('unknown cost stays unknown when another round reports a price', async () => {
  const model = script([
    turn([call('inspect_design', {})], { usage: { inputTokens: 10, outputTokens: 5, cost: null } }),
    turn([finish('question')]),
  ]);
  const result = await runAgent({ scene: house(), messages, client: model.client });
  assert.equal(result.usage.cost, null);
  assert.equal(result.usage.calls, 2);
});

test('out-of-range scratch geometry remains inspectable and repairable without losing the failed operation', async () => {
  const scene = {
    ...emptyScene,
    rooms: [makeRoom({ id: 'edge', name: 'Edge room', x: 55, width: 4 })],
  };
  const draft = new DesignDraft(scene);
  draft.apply([{ type: 'set_material', palette: 'cedar' }]);
  const invalid = draft.apply([{ type: 'move_group', roomIds: ['edge'], dx: 10, dz: 0 }]);
  assert.equal(invalid.applied, true);
  assert.equal(
    draft.scene.rooms[0].x,
    65,
    'the working draft preserves the geometry that needs repair',
  );
  assert.ok(draft.issues.some((issue) => issue.code === 'scene_schema'));
  assert.ok(draft.inspect().issues.some((issue) => issue.code === 'scene_schema'));
  const repaired = draft.apply([{ type: 'move_group', roomIds: ['edge'], dx: -10, dz: 0 }]);
  assert.equal(
    repaired.issues.some((issue) => issue.severity === 'error'),
    false,
  );
  assert.equal(draft.scene.rooms[0].x, 55);
  assert.equal(draft.scene.palette, 'cedar');
  assert.equal(scene.palette, 'limestone');
});

test('malformed mutations after a valid partial edit cannot be silently finished as success', async () => {
  const model = script([
    turn([call('apply_operations', { operations: [{ type: 'set_material', palette: 'cedar' }] })]),
    turn([
      call('apply_operations', {
        operations: [{ type: 'resize_room', roomId: 'kitchen', width: 0, anchor: 'west' }],
      }),
    ]),
    turn([finish()]),
    (history) => {
      const rejection = toolResults(history).at(-1);
      assert.equal(rejection.ok, false);
      assert.ok(
        rejection.issues.some((issue: { code: string }) => issue.code === 'invalid_tool_arguments'),
      );
      return turn([
        call('apply_operations', {
          operations: [{ type: 'resize_room', roomId: 'kitchen', width: 6, anchor: 'west' }],
        }),
      ]);
    },
    turn([finish()]),
  ]);
  const result = await runAgent({ scene: house(), messages, client: model.client });
  assert.equal(result.scene?.palette, 'cedar');
  assert.equal(result.scene?.rooms[0].width, 6);
  assert.equal(
    result.usage.calls,
    5,
    'finish requires a successful repair after the malformed operation',
  );
});

test('inspection reports strict commit checks and unresolved mutation failures', () => {
  const draft = new DesignDraft(house());
  draft.apply([{ type: 'add_rooms', rooms: [makeRoom({ id: 'orphan', x: 25 })] }]);
  assert.ok(
    draft
      .inspect()
      .issues.some((issue) => issue.code === 'new_disconnected_room' && issue.severity === 'error'),
  );
  draft.recordFailure([
    { code: 'test_failure', severity: 'error', message: 'Operation failed.', objectIds: [] },
  ]);
  assert.ok(draft.inspect().issues.some((issue) => issue.code === 'test_failure'));
  draft.reset();
  assert.equal(
    draft.inspect().issues.some((issue) => issue.code === 'test_failure'),
    false,
  );
});

test('cancellation during quota accounting or final readiness prevents completion', async () => {
  for (const atReadiness of [false, true]) {
    const controller = new AbortController();
    const model = script(atReadiness ? [turn([finish('question')])] : []);
    await assert.rejects(
      runAgent({
        scene: house(),
        messages,
        client: model.client,
        signal: controller.signal,
        beforeModelCall: async () => {
          if (!atReadiness) controller.abort();
        },
        onEvent: (event) => {
          if (atReadiness && event.stage === 'ready') controller.abort();
        },
      }),
      (error) => error instanceof DOMException && error.name === 'AbortError',
    );
    assert.equal(model.calls, atReadiness ? 1 : 0);
  }
});

test('a finish call cannot silently skip later operations in the same provider turn', async () => {
  const model = script([
    turn([call('apply_operations', { operations: [{ type: 'set_material', palette: 'cedar' }] })]),
    turn([
      finish(),
      call('apply_operations', {
        operations: [{ type: 'resize_room', roomId: 'kitchen', width: 6, anchor: 'west' }],
      }),
    ]),
    (history) => {
      assert.ok(
        toolResults(history).some(
          (result) =>
            typeof result.error === 'string' && /must be the last tool/.test(result.error),
        ),
      );
      return turn([finish()]);
    },
  ]);
  const result = await runAgent({ scene: house(), messages, client: model.client });
  assert.equal(result.scene?.rooms[0].width, 6);
  assert.equal(result.usage.calls, 3);
});

test('a confirmed brief on an empty site remains protected during the first house design', () => {
  const original: Scene = {
    ...emptyScene,
    design: {
      groups: [],
      connections: [],
      stairLinks: [],
      requirements: [
        {
          id: 'brief',
          kind: 'intent',
          source: 'confirmed',
          description: 'Keep a central fireplace.',
        },
      ],
    },
  };
  const draft = new DesignDraft(original);
  draft.apply([
    { type: 'remove_requirement', requirementId: 'brief' },
    { type: 'add_rooms', rooms: [makeRoom({ id: 'living' })] },
  ]);
  assert.equal(draft.needsConfirmation, true);
});

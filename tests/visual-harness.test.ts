import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, type ModelTurn, type ModelMessage } from '../server/agent.ts';
import {
  RenderUnavailable,
  sceneFingerprint,
  type RenderProvider,
} from '../server/render-service.ts';
import { emptyScene, makeRoom, type Scene } from '../shared/model.ts';
import { renderCamera } from '../shared/render.ts';

const scene = {
  ...emptyScene,
  rooms: [makeRoom({ id: 'living', name: 'Living room', kind: 'living', width: 8, depth: 6 })],
};
const messages = [
  { id: 'user', role: 'user' as const, text: 'Make this wall cedar and check it visually.' },
];
const image = 'data:image/png;base64,iVBORw0KGgo=';
function turn(name: string, args: unknown): ModelTurn {
  return {
    calls: [{ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
    content: null,
    truncated: false,
    usage: { inputTokens: 100, outputTokens: 30, cost: 0.001 },
  };
}
const edit = () =>
  turn('apply_operations', {
    operations: [
      { type: 'set_surface_material', roomId: 'living', surface: 'north', palette: 'cedar' },
    ],
  });
const render = () => turn('render_view', { view: 'interior', roomId: 'living' });
const finish = () =>
  turn('finish_design', {
    mode: 'apply',
    reply: 'The north wall is cedar. I inspected its interior view.',
  });
const provider: RenderProvider = async (draft, request) => {
  const { position, target } = renderCamera(draft, request);
  return {
    image,
    width: 768,
    height: 576,
    sceneHash: sceneFingerprint(draft),
    view: request.view,
    camera: { position, target },
  };
};
const context = {
  allowVisualReview: true,
  selection: { roomId: 'living', surface: 'north' as const },
  selectedRoomId: 'living',
};

test('the agent sees a fresh local draft image after tool results before accepting a surface edit', async () => {
  let calls = 0,
    rendered: Scene | undefined;
  const result = await runAgent({
    scene,
    messages,
    context,
    render: async (draft, request, signal) => {
      rendered = draft;
      return provider(draft, request, signal);
    },
    client: {
      async complete(history) {
        calls++;
        if (calls === 1) {
          assert.ok(JSON.stringify(history).includes('visualReviewAvailable'));
          assert.ok(
            history.some(
              (m) => typeof m.content === 'string' && m.content.includes('"surface":"north"'),
            ),
          );
          return edit();
        }
        if (calls === 2) return render();
        const last = history.at(-1)!;
        assert.equal(last.role, 'user');
        assert.ok(Array.isArray(last.content));
        assert.ok(JSON.stringify(last.content).includes(image));
        assert.equal(history.at(-2)?.role, 'tool');
        assert.ok(JSON.stringify(last.content).includes(sceneFingerprint(rendered!)));
        return finish();
      },
    },
  });
  assert.equal(rendered?.rooms[0].surfacePalettes?.north, 'cedar');
  assert.equal(result.scene?.rooms[0].surfacePalettes?.north, 'cedar');
  assert.equal(scene.rooms[0].surfacePalettes, undefined);
  assert.equal(result.usage.calls, 3);
  assert.equal(result.events.filter((e) => e.stage === 'rendering').length, 1);
  assert.equal(
    JSON.stringify(result.events).includes(image),
    false,
    'image bytes are excluded from diagnostic events',
  );
});

test('finishing without visual evidence is repaired and an edited image cannot be reused for a newer draft', async () => {
  let index = 0,
    captures = 0;
  const turns = [
    edit(),
    render(),
    turn('apply_operations', {
      operations: [
        { type: 'set_surface_material', roomId: 'living', surface: 'north', palette: 'chalk' },
      ],
    }),
    finish(),
    render(),
    finish(),
  ];
  const result = await runAgent({
    scene,
    messages,
    context,
    render: async (...args) => {
      captures++;
      return provider(...args);
    },
    client: {
      async complete(history) {
        if (index === 4) assert.ok(JSON.stringify(history.at(-1)).includes('fresh view'));
        return turns[index++];
      },
    },
  });
  assert.equal(captures, 2);
  assert.equal(result.scene?.rooms[0].surfacePalettes?.north, 'chalk');
  assert.equal(result.events.filter((e) => e.stage === 'repairing').length, 1);
});

test('same-turn finishing cannot pretend to have examined a just-requested image', async () => {
  let index = 0;
  const result = await runAgent({
    scene,
    messages,
    context,
    render: provider,
    client: {
      async complete(history) {
        index++;
        if (index === 1) return edit();
        if (index === 2) {
          const capture = render();
          capture.calls.push(finish().calls[0]);
          return capture;
        }
        assert.equal(history.at(-1)?.role, 'user');
        assert.ok(JSON.stringify(history).includes('next round'));
        return finish();
      },
    },
  });
  assert.equal(index, 3);
  assert.equal(result.events.filter((e) => e.stage === 'repairing').length, 1);
});

test('wrong-draft captures and unavailable renderers stop the attempt without a successful result', async () => {
  for (const renderProvider of [
    async (...args: Parameters<RenderProvider>) => ({
      ...(await provider(...args)),
      sceneHash: '0'.repeat(64),
    }),
    async () => {
      throw new RenderUnavailable();
    },
  ]) {
    let index = 0;
    await assert.rejects(
      runAgent({
        scene,
        messages,
        context,
        render: renderProvider,
        client: {
          async complete() {
            return index++ === 0 ? edit() : render();
          },
        },
      }),
      /match|unavailable/,
    );
    assert.equal(index, 2);
  }
});

test('a custom render provider cannot substitute the wrong camera even with a matching scene hash and view', async () => {
  let calls = 0;
  await assert.rejects(
    runAgent({
      scene,
      messages,
      context,
      render: async (...args) => {
        const capture = await provider(...args);
        capture.camera.position[0] += 1;
        return capture;
      },
      client: {
        async complete() {
          calls++;
          if (calls === 1) return edit();
          assert.equal(calls, 2, 'Mismatched render evidence must stop before another model call.');
          return render();
        },
      },
    }),
    /did not match.*camera/,
  );
  assert.equal(calls, 2);
  assert.equal(scene.rooms[0].surfacePalettes, undefined, 'The input house remains unchanged.');
});

test('visual captures are bounded and disabled review never invokes a renderer', async () => {
  let captures = 0;
  await assert.rejects(
    runAgent({
      scene,
      messages,
      context,
      render: async (...args) => {
        captures++;
        return provider(...args);
      },
      client: {
        async complete() {
          return render();
        },
      },
    }),
    /three-image/,
  );
  assert.equal(captures, 3);
  let index = 0;
  const turns = [render(), edit(), finish()];
  const result = await runAgent({
    scene,
    messages,
    context: { ...context, allowVisualReview: false },
    render: async () => {
      throw Error('Must not render');
    },
    client: {
      async complete(history) {
        if (index === 1) assert.ok(JSON.stringify(history.at(-1)).includes('unavailable'));
        return turns[index++];
      },
    },
  });
  assert.ok(result.scene);
});

test('stale or contradictory surface selections are rejected before a model call', async () => {
  for (const selectionContext of [
    { selection: { roomId: 'missing', surface: 'north' as const } },
    { selection: { roomId: 'living', surface: 'floor' as const }, selectedRoomId: 'other' },
  ]) {
    await assert.rejects(
      runAgent({
        scene,
        messages,
        context: selectionContext,
        client: {
          async complete() {
            assert.fail('No paid call for invalid selection');
          },
        },
      }),
      /selection|surface/,
    );
  }
});

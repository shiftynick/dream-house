import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, gatewayAgentModel, type ModelTurn, type ModelMessage } from '../server/agent.ts';
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
const finish = (captureId = 'capture-1') =>
  turn('finish_design', {
    mode: 'apply',
    visualReview: {
      status: 'passed',
      captureIds: [captureId],
      observations: ['The north wall color is consistent in the supplied interior image.'],
    },
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
    finish('capture-2'),
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
  let captures = 0,
    requested = 0;
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
          return turn('render_view', {
            view: 'interior',
            roomId: 'living',
            angle: ['northeast', 'northwest', 'southeast', 'southwest'][requested++],
          });
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

function review(captureIds = ['capture-1'], status = 'passed') {
  return {
    status,
    captureIds,
    observations: ['The supplied live view shows the requested wall material.'],
    limitations: [],
  };
}
function finishReview(visualReview?: unknown) {
  return turn('finish_design', {
    mode: 'apply',
    reply: 'Changed the north wall.',
    ...(visualReview ? { visualReview } : {}),
  });
}
function toolResults(history: ModelMessage[]) {
  return history
    .filter((message) => message.role === 'tool')
    .map((message) => JSON.parse(String(message.content)));
}

test('a delivered image requires explicit observations and known capture IDs before finishing', async () => {
  for (const [input, expected] of [
    [undefined, /Supply visualReview/],
    [review(['unknown']), /has not been delivered/],
  ] as const) {
    let round = 0;
    const result = await runAgent({
      scene,
      messages,
      context,
      render: provider,
      client: {
        async complete(history) {
          round++;
          if (round === 1) return edit();
          if (round === 2) return render();
          if (round === 3) return finishReview(input);
          assert.match(toolResults(history).at(-1).error, expected);
          return finishReview(review());
        },
      },
    });
    assert.equal(result.visualReview?.verification, 'model');
    assert.equal(result.visualReview?.captures[0].captureId, 'capture-1');
    assert.equal(result.visualReview?.captures[0].quality, 'live');
    assert.equal(result.visualReview?.captures[0].angle, 'southeast');
    assert.equal(result.needsConfirmation, false);
    assert.equal(round, 4);
  }
});

test('capture IDs cannot acknowledge images requested in the same model round', async () => {
  let round = 0;
  const result = await runAgent({
    scene,
    messages,
    context,
    render: provider,
    client: {
      async complete(history) {
        round++;
        if (round === 1) return edit();
        if (round === 2) {
          const capture = render();
          capture.calls.push(...finishReview(review()).calls);
          return capture;
        }
        assert.match(toolResults(history).at(-1).error, /examine its image in the next round/);
        return finishReview(review());
      },
    },
  });
  assert.equal(round, 3, 'acknowledgment and finish share the image-delivery round');
  assert.equal(result.visualReview?.captures.length, 1);
});

test('an old capture ID stays stale even after a fresh final-draft image is delivered', async () => {
  let round = 0;
  const result = await runAgent({
    scene,
    messages,
    context,
    render: provider,
    client: {
      async complete(history) {
        round++;
        if (round === 1) return edit();
        if (round === 2 || round === 4) return render();
        if (round === 3)
          return turn('apply_operations', {
            operations: [
              {
                type: 'set_surface_material',
                roomId: 'living',
                surface: 'north',
                palette: 'chalk',
              },
            ],
          });
        if (round === 5) return finishReview(review(['capture-1']));
        assert.match(toolResults(history).at(-1).error, /stale/);
        return finishReview(review(['capture-2']));
      },
    },
  });
  assert.equal(result.visualReview?.captures[0].sceneHash, sceneFingerprint(result.scene!));
  assert.deepEqual(result.visualReview?.captureIds, ['capture-2']);
});

test('material edits reject plan, clay and wireframe acknowledgments without a color view', async () => {
  for (const unsuitable of [
    { view: 'plan' },
    { view: 'interior', roomId: 'living', quality: 'clay' },
    { view: 'exterior', quality: 'wireframe' },
  ]) {
    let round = 0;
    const result = await runAgent({
      scene,
      messages,
      context,
      render: provider,
      client: {
        async complete(history) {
          round++;
          if (round === 1) return edit();
          if (round === 2) return turn('render_view', unsuitable);
          if (round === 3) return finishReview(review());
          if (round === 4) {
            assert.match(toolResults(history).at(-1).error, /live 3D color capture/);
            return render();
          }
          return finishReview(review(['capture-2']));
        },
      },
    });
    assert.equal(result.visualReview?.captures[0].quality, 'live');
    assert.equal(result.metrics?.captures, 2);
  }
});

test('targeted interior wall review rejects the opposite-facing preset without certifying visibility', async () => {
  let round = 0;
  const result = await runAgent({
    scene,
    messages,
    context,
    render: provider,
    client: {
      async complete(history) {
        round++;
        if (round === 1) return edit();
        if (round === 2)
          return turn('render_view', { view: 'interior', roomId: 'living', angle: 'northeast' });
        if (round === 3) return finishReview(review());
        if (round === 4) {
          assert.match(
            toolResults(history).at(-1).error,
            /appropriately oriented.*Metadata does not prove visibility/,
          );
          return render();
        }
        return finishReview(review(['capture-2']));
      },
    },
  });
  assert.equal(result.visualReview?.verification, 'model');
});

test('issues and unverified visual judgments disclose observations and require confirmation', async () => {
  for (const status of ['issues', 'unverified']) {
    let round = 0;
    const result = await runAgent({
      scene,
      messages,
      context,
      render: provider,
      client: {
        async complete() {
          round++;
          if (round === 1) return edit();
          if (round === 2) return render();
          return finishReview({
            ...review(['capture-1'], status),
            observations: ['The adjoining wall appears different.'],
            limitations: ['The roof edge is obscured.'],
          });
        },
      },
    });
    assert.equal(result.needsConfirmation, true);
    assert.equal(result.visualReview?.status, status);
    assert.match(
      result.reply,
      /model judgment.*adjoining wall appears different.*roof edge is obscured/,
    );
    assert.ok(result.events.some((event) => event.message.includes(`Visual review ${status}`)));
    assert.deepEqual(
      result.scene?.design?.requirements,
      [],
      'review adds no persistent requirements',
    );
    assert.equal(JSON.stringify(result.visualReview).includes(image), false);
  }
});

test('disabled visual permission suppresses supplied viewport pixels and review metadata', async () => {
  let round = 0;
  const result = await runAgent({
    scene,
    messages,
    context: { ...context, allowVisualReview: false, image },
    render: provider,
    client: {
      async complete(history) {
        assert.equal(JSON.stringify(history).includes(image), false);
        assert.equal(
          history.some(
            (message) =>
              Array.isArray(message.content) &&
              message.content.some((part) => part.type === 'image_url'),
          ),
          false,
        );
        return ++round === 1 ? edit() : finishReview();
      },
    },
  });
  assert.equal(result.visualReview, undefined);
  assert.equal(result.metrics?.imageBytesSent, 0);
  assert.equal(result.metrics?.captures, 0);
});

test('the actual gateway adapter forwards the image and its capture provenance after paired tool results', async () => {
  let round = 0;
  const client = gatewayAgentModel('test-key', 'test/vision', async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    round++;
    let next: ModelTurn;
    if (round === 1) next = edit();
    else if (round === 2) next = render();
    else {
      const history = body.messages as ModelMessage[];
      assert.equal(history.at(-2)?.role, 'tool');
      assert.equal(toolResults(history).at(-1).captureId, 'capture-1');
      assert.equal(toolResults(history).at(-1).light, 'day');
      assert.deepEqual(
        (history.at(-1)?.content as { type: string; image_url?: { url: string } }[]).find(
          (part) => part.type === 'image_url',
        )?.image_url,
        { url: image },
      );
      next = finishReview(review());
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { tool_calls: next.calls }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });
  const result = await runAgent({ scene, messages, context, render: provider, client });
  assert.equal(round, 3);
  assert.equal(result.visualReview?.status, 'passed');
});

test('roof structure and palette edits require exterior evidence, not interior ceilings or cutaways', async () => {
  for (const operation of [
    { type: 'set_roof', style: 'single-pitch', pitch: 12, direction: 'north' },
    { type: 'set_surface_material', roomId: 'living', surface: 'roof', palette: 'cedar' },
  ]) {
    for (const view of ['interior', 'cutaway']) {
      let round = 0;
      const result = await runAgent({
        scene,
        messages,
        context,
        render: provider,
        client: {
          async complete(history) {
            round++;
            if (round === 1) return turn('apply_operations', { operations: [operation] });
            if (round === 2) return turn('render_view', { view, roomId: 'living' });
            if (round === 3) return finishReview(review());
            if (round === 4) {
              assert.match(toolResults(history).at(-1).error, /live exterior capture/);
              return turn('render_view', { view: 'exterior' });
            }
            return finishReview(review(['capture-2']));
          },
        },
      });
      assert.equal(result.visualReview?.captures[0].view, 'exterior');
    }
  }
});

test('a focused unchanged-room image cannot review appearance changes elsewhere without selection', async () => {
  const multiRoom = {
    ...scene,
    rooms: [scene.rooms[0], makeRoom({ id: 'kitchen', x: 8, width: 8, depth: 6 })],
  };
  let round = 0;
  const result = await runAgent({
    scene: multiRoom,
    messages,
    context: { allowVisualReview: true },
    render: provider,
    client: {
      async complete(history) {
        round++;
        if (round === 1)
          return turn('apply_operations', {
            operations: [
              {
                type: 'set_surface_material',
                roomId: 'kitchen',
                surface: 'north',
                palette: 'cedar',
              },
            ],
          });
        if (round === 2) return turn('render_view', { view: 'interior', roomId: 'living' });
        if (round === 3) return finishReview(review());
        if (round === 4) {
          assert.match(toolResults(history).at(-1).error, /changed appearance in rooms kitchen/);
          return turn('render_view', { view: 'cutaway' });
        }
        return finishReview(review(['capture-2']));
      },
    },
  });
  assert.equal(
    result.visualReview?.captures[0].roomId,
    undefined,
    'one whole-scene color view covers multiple requested rooms by metadata',
  );
  assert.equal(result.visualReview?.captures[0].view, 'cutaway');
});

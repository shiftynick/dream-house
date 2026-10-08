import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_TOOLS, runAgent, type ModelMessage, type ModelTurn } from '../server/agent.ts';
import { emptyScene, makeRoom } from '../shared/model.ts';
import { renderCamera } from '../shared/render.ts';
import { sceneFingerprint } from '../server/render-service.ts';
import { retireReviewedImages } from '../server/agent-context.ts';

const scene = { ...emptyScene, rooms: [makeRoom({ id: 'living', width: 8, depth: 6 })] };
const messages = [
  {
    id: 'request',
    role: 'user' as const,
    text: 'Give the house a cedar exterior and a single-pitch roof.',
  },
];
let nextCallId = 0;
function turn(name: string, args: unknown): ModelTurn {
  return {
    calls: [
      {
        id: `call-${nextCallId++}`,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
    content: null,
    truncated: false,
    usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
  };
}
const edit = () =>
  turn('apply_operations', { operations: [{ type: 'set_material', palette: 'cedar' }] });
const assessment = () => ({
  requirements: [
    {
      id: 'cedar',
      request: 'Cedar exterior.',
      status: 'fulfilled',
      evidence: 'The house palette is cedar.',
      checks: [{ kind: 'material', roomId: 'living', palette: 'cedar' }],
    },
    {
      id: 'roof',
      request: 'A single-pitch roof.',
      status: 'fulfilled',
      evidence: 'The roof setting was checked.',
      checks: [{ kind: 'roof', roomId: 'living', style: 'single-pitch' }],
    },
  ],
});
const finish = (value?: unknown, visualReview?: unknown) =>
  turn('finish_design', {
    mode: 'apply',
    reply: 'I updated the house.',
    ...(value ? { assessment: value } : {}),
    ...(visualReview ? { visualReview } : {}),
  });
const results = (history: ModelMessage[]) =>
  history
    .filter((message) => message.role === 'tool')
    .map((message) => JSON.parse(String(message.content)));

test('a valid partial edit cannot automatically apply while a required roof remains wrong', async () => {
  const turns = [edit(), finish(assessment())];
  const result = await runAgent({
    scene,
    messages,
    client: {
      async complete() {
        return turns.shift()!;
      },
    },
  });
  assert.equal(result.scene?.palette, 'cedar');
  assert.equal(result.needsConfirmation, true);
  assert.equal(result.assessment?.requirements[1].status, 'partial');
  assert.match(result.reply, /Still outstanding: A single-pitch roof/);
  assert.equal(scene.palette, 'limestone', 'the original house stays untouched');
});

test('review_design exposes failed requirements so a simulated agent repairs them before finishing', async () => {
  let round = 0;
  const result = await runAgent({
    scene,
    messages,
    client: {
      async complete(history) {
        round++;
        if (round === 1) return edit();
        if (round === 2) return turn('review_design', assessment());
        if (round === 3) {
          assert.equal(results(history).at(-1).assessment.requirements[1].results[0].passed, false);
          return turn('apply_operations', {
            operations: [
              { type: 'set_roof', style: 'single-pitch', pitch: 12, direction: 'south' },
            ],
          });
        }
        return finish(assessment());
      },
    },
  });
  assert.equal(result.needsConfirmation, false);
  assert.equal(result.scene?.roof, 'single-pitch');
  assert.ok(result.assessment?.requirements.every((item) => item.status === 'fulfilled'));
  assert.equal(result.usage.cost, 0, 'scenario verification uses no provider');
});

test('finishing cannot silently drop a previously reviewed failed requirement or its checks', async () => {
  for (const omitAssessment of [false, true]) {
    let round = 0;
    const result = await runAgent({
      scene,
      messages,
      client: {
        async complete(history) {
          round++;
          if (round === 1) return edit();
          if (round === 2) return turn('review_design', assessment());
          if (round === 3) {
            const weakened = assessment();
            weakened.requirements[1].checks = [];
            return finish(omitAssessment ? undefined : weakened);
          }
          assert.match(
            results(history).at(-1).error,
            omitAssessment ? /previously reviewed request checklist/ : /Keep requirement roof/,
          );
          return finish(assessment());
        },
      },
    });
    assert.equal(result.needsConfirmation, true);
    assert.equal(result.usage.calls, 4);
  }
});

test('public provider finish contract requires assessment while older injected adapters remain compatible', async () => {
  const tool = AGENT_TOOLS.find((candidate) => candidate.name === 'finish_design')!;
  assert.equal(tool.schema.safeParse({ mode: 'question', reply: 'Which room?' }).success, false);
  assert.equal(
    tool.schema.safeParse({ mode: 'question', reply: 'Which room?', assessment: assessment() })
      .success,
    true,
  );
  const result = await runAgent({
    scene,
    messages,
    client: {
      async complete() {
        return turn('finish_design', { mode: 'question', reply: 'Which room?' });
      },
    },
  });
  assert.equal(result.scene, null);
});

test('current capture pixels survive review_design through finish and cached requests reuse one image', async () => {
  const image = 'data:image/png;base64,iVBORw0KGgo=';
  let round = 0,
    captures = 0;
  const histories: ModelMessage[][] = [];
  const result = await runAgent({
    scene,
    messages,
    context: { image, allowVisualReview: true },
    render: async (draft, request) => {
      captures++;
      const { position, target } = renderCamera(draft, request);
      return {
        image,
        width: 768,
        height: 576,
        sceneHash: sceneFingerprint(draft),
        view: request.view,
        camera: { position, target },
      };
    },
    client: {
      async complete(history) {
        histories.push(structuredClone(history));
        round++;
        if (round === 1) return edit();
        if (round === 2 || round === 3) return turn('render_view', { view: 'exterior' });
        if (round === 4)
          return turn('review_design', { requirements: [assessment().requirements[0]] });
        return finish(
          { requirements: [assessment().requirements[0]] },
          {
            status: 'passed',
            captureIds: ['capture-1'],
            observations: [
              'The exterior cedar surfaces look coordinated in the supplied color view.',
            ],
          },
        );
      },
    },
  });
  const imageCount = (history: ModelMessage[]) =>
    history.reduce(
      (count, message) =>
        count +
        (Array.isArray(message.content)
          ? message.content.filter((part) => part.type === 'image_url').length
          : 0),
      0,
    );
  assert.deepEqual(histories.map(imageCount), [1, 0, 1, 1, 1]);
  assert.equal(captures, 1);
  assert.equal(result.metrics?.captures, 1);
  assert.equal(result.metrics?.reusedCaptures, 1);
  assert.equal(result.metrics?.toolCalls, 5);
  assert.ok(result.metrics!.compactedCharacters > 0);
  assert.ok(result.metrics!.elapsedMs >= result.metrics!.modelMs);
  assert.ok(result.metrics!.imageBytesSent > 0);
  assert.match(String(histories[1][1].content), /"palette":"cedar"/);
  assert.ok(results(histories[1])[0].snapshot);
  assert.equal(results(histories[1])[0].scene, undefined);
  assert.ok(results(histories[1])[0].changes.length, 'operation evidence is retained');
  for (const history of histories) {
    const calls = history.flatMap((message) => message.tool_calls || []);
    for (const call of calls)
      assert.ok(
        history.some((message) => message.role === 'tool' && message.tool_call_id === call.id),
        'tool-call and result protocol pairing survives compaction',
      );
  }
});

test('all current views persist while changed-scene pixels retire even when image bytes are identical', async () => {
  const image = 'data:image/png;base64,iVBORw0KGgo=';
  let round = 0;
  const histories: ModelMessage[][] = [];
  const pixelMessages = (history: ModelMessage[]) =>
    history.filter(
      (message) =>
        Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url'),
    );
  const result = await runAgent({
    scene,
    messages,
    context: { image, allowVisualReview: true },
    render: async (draft, request) => {
      const { position, target } = renderCamera(draft, request);
      return {
        image,
        width: 768,
        height: 576,
        sceneHash: sceneFingerprint(draft),
        view: request.view,
        camera: { position, target },
      };
    },
    client: {
      async complete(history) {
        histories.push(structuredClone(history));
        round++;
        if (round === 1) return edit();
        if (round === 2) {
          const views = turn('render_view', { view: 'exterior' });
          views.calls.push(...turn('render_view', { view: 'interior', roomId: 'living' }).calls);
          return views;
        }
        if (round === 3) return turn('inspect_design', {});
        if (round === 4) {
          assert.equal(pixelMessages(history).length, 2);
          assert.match(String(history[2].content), /"imageAvailableToReviewNow":true/);
          return turn('apply_operations', {
            operations: [{ type: 'set_material', palette: 'chalk' }],
          });
        }
        if (round === 5) {
          assert.equal(pixelMessages(history).length, 0);
          assert.match(String(history[2].content), /"imageAvailableToReviewNow":false/);
          return turn('render_view', { view: 'exterior' });
        }
        assert.equal(pixelMessages(history).length, 1);
        assert.match(JSON.stringify(pixelMessages(history)), /capture capture-3/);
        return finish(undefined, {
          status: 'passed',
          captureIds: ['capture-3'],
          observations: ['The current chalk exterior is coordinated.'],
        });
      },
    },
  });
  assert.deepEqual(
    histories.map((history) => pixelMessages(history).length),
    [1, 0, 2, 2, 0, 1],
  );
  assert.equal(result.metrics?.captures, 3);
  assert.equal(result.visualReview?.status, 'passed');
});

test('disabled visual review sends no retained or viewport pixels', async () => {
  let round = 0;
  await runAgent({
    scene,
    messages,
    context: { image: 'data:image/png;base64,iVBORw0KGgo=', allowVisualReview: false },
    render: async () => {
      throw new Error('Disabled review must not render');
    },
    client: {
      async complete(history) {
        assert.ok(
          history.every(
            (message) =>
              !Array.isArray(message.content) ||
              message.content.every((part) => part.type !== 'image_url'),
          ),
        );
        return ++round === 1 ? edit() : finish();
      },
    },
  });
});

test('captures invalidated before their first delivery never become delivered evidence', async () => {
  let round = 0;
  const result = await runAgent({
    scene,
    messages,
    context: { allowVisualReview: true },
    render: async (draft, request) => {
      const { position, target } = renderCamera(draft, request);
      return {
        image: 'data:image/png;base64,iVBORw0KGgo=',
        width: 768,
        height: 576,
        sceneHash: sceneFingerprint(draft),
        view: request.view,
        camera: { position, target },
      };
    },
    client: {
      async complete(history) {
        round++;
        if (round === 1) return edit();
        if (round === 2) {
          const stale = turn('render_view', { view: 'exterior' });
          stale.calls.push(
            ...turn('apply_operations', {
              operations: [{ type: 'set_material', palette: 'chalk' }],
            }).calls,
          );
          return stale;
        }
        if (round === 3) {
          assert.ok(
            history.every(
              (message) =>
                !Array.isArray(message.content) ||
                message.content.every((part) => part.type !== 'image_url'),
            ),
          );
          return turn('render_view', { view: 'exterior' });
        }
        if (round === 5)
          assert.match(results(history).at(-1).error, /capture-1 has not been delivered/);
        return finish(undefined, {
          status: 'passed',
          captureIds: [round === 4 ? 'capture-1' : 'capture-2'],
          observations: ['The current exterior materials are consistent.'],
        });
      },
    },
  });
  assert.equal(result.visualReview?.captures[0].captureId, 'capture-2');
  assert.equal(round, 5);
});

test('image retirement defaults to removing all pixels and retains only explicit message identities', () => {
  const makeImage = (): ModelMessage => ({
    role: 'user',
    content: [
      { type: 'text', text: 'capture provenance' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
    ],
  });
  const stale = makeImage(),
    current = makeImage();
  retireReviewedImages([stale, current], new Set([current]));
  assert.ok(
    Array.isArray(stale.content) && stale.content.every((part) => part.type !== 'image_url'),
  );
  assert.ok(
    Array.isArray(current.content) && current.content.some((part) => part.type === 'image_url'),
  );
  retireReviewedImages([current]);
  assert.ok(
    Array.isArray(current.content) && current.content.every((part) => part.type !== 'image_url'),
  );
});

test('returning to a previously reviewed scene requires cached image rehydration and a delivery round', async () => {
  for (const reset of [false, true]) {
    let round = 0,
      renders = 0;
    const visual = {
      status: 'passed',
      captureIds: ['capture-1'],
      observations: ['The cedar exterior appears consistent.'],
    };
    const result = await runAgent({
      scene,
      messages,
      context: { allowVisualReview: true },
      render: async (draft, request) => {
        renders++;
        const { position, target } = renderCamera(draft, request);
        return {
          image: 'data:image/png;base64,iVBORw0KGgo=',
          width: 768,
          height: 576,
          sceneHash: sceneFingerprint(draft),
          view: request.view,
          camera: { position, target },
        };
      },
      client: {
        async complete(history) {
          round++;
          if (round === 1) return edit();
          if (round === 2) return turn('render_view', { view: 'exterior' });
          if (round === 3) {
            const away = reset
              ? turn('reset_draft', {})
              : turn('apply_operations', {
                  operations: [{ type: 'set_material', palette: 'chalk' }],
                });
            away.calls.push(...edit().calls, ...finish(undefined, visual).calls);
            return away;
          }
          if (round === 4) {
            assert.match(
              results(history).at(-1).error,
              /Editing after a capture requires a fresh view/,
            );
            assert.ok(
              history.every(
                (message) =>
                  !Array.isArray(message.content) ||
                  message.content.every((part) => part.type !== 'image_url'),
              ),
            );
            const cached = turn('render_view', { view: 'exterior' });
            cached.calls.push(...finish(undefined, visual).calls);
            return cached;
          }
          assert.match(results(history).at(-1).error, /examine its image in the next round/);
          assert.equal(
            history.filter(
              (message) =>
                Array.isArray(message.content) &&
                message.content.some((part) => part.type === 'image_url'),
            ).length,
            1,
          );
          assert.match(JSON.stringify(history.at(-1)), /capture capture-1/);
          return finish(undefined, visual);
        },
      },
    });
    assert.equal(round, 5);
    assert.equal(renders, 1);
    assert.equal(result.metrics?.reusedCaptures, 1);
    assert.equal(result.visualReview?.captures[0].captureId, 'capture-1');
  }
});

test('no-op and rejected operations preserve unchanged-scene review after next-round repair', async () => {
  let round = 0;
  const visual = {
    status: 'passed',
    captureIds: ['capture-1'],
    observations: ['The unchanged cedar exterior is consistent.'],
  };
  const result = await runAgent({
    scene,
    messages,
    context: { allowVisualReview: true },
    render: async (draft, request) => {
      const { position, target } = renderCamera(draft, request);
      return {
        image: 'data:image/png;base64,iVBORw0KGgo=',
        width: 768,
        height: 576,
        sceneHash: sceneFingerprint(draft),
        view: request.view,
        camera: { position, target },
      };
    },
    client: {
      async complete(history) {
        round++;
        if (round === 1) return edit();
        if (round === 2) return turn('render_view', { view: 'exterior' });
        if (round === 4) {
          assert.ok(
            results(history)
              .slice(-2)
              .every((output) => output.executed === false),
          );
          const repaired = edit();
          repaired.calls.push(...finish(undefined, visual).calls);
          return repaired;
        }
        const rejected = turn('apply_operations', { operations: [{ type: 'not_an_operation' }] });
        rejected.calls.push(...edit().calls, ...finish(undefined, visual).calls);
        return rejected;
      },
    },
  });
  assert.equal(round, 4);
  assert.equal(result.visualReview?.status, 'passed');
});

test('cached image from a reviewed scene cannot bypass next-round review after a new render request', async () => {
  const image = 'data:image/png;base64,iVBORw0KGgo=';
  let round = 0;
  const result = await runAgent({
    scene,
    messages,
    context: { allowVisualReview: true },
    render: async (draft, request) => {
      const { position, target } = renderCamera(draft, request);
      return {
        image,
        width: 768,
        height: 576,
        sceneHash: sceneFingerprint(draft),
        view: request.view,
        camera: { position, target },
      };
    },
    client: {
      async complete(history) {
        round++;
        if (round === 1) return edit();
        if (round === 2) return turn('render_view', { view: 'exterior' });
        if (round === 3) {
          const rendered = turn('render_view', { view: 'exterior' });
          rendered.calls.push(...finish().calls);
          return rendered;
        }
        assert.match(results(history).at(-1).error, /examine its image in the next round/);
        return finish(undefined, {
          status: 'passed',
          captureIds: ['capture-1'],
          observations: [
            'The exterior cedar surfaces look coordinated in the supplied color view.',
          ],
        });
      },
    },
  });
  assert.equal(result.usage.calls, 4);
  assert.equal(result.metrics?.reusedCaptures, 1);
});

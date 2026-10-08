import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, type ModelMessage, type ModelTurn } from '../server/agent.ts';
import { DesignDraft } from '../shared/draft.ts';
import { emptyScene, makeRoom } from '../shared/model.ts';
import { renderCamera } from '../shared/render.ts';
import { sceneFingerprint, type RenderProvider } from '../server/render-service.ts';

const messages = [
  {
    id: 'owner',
    role: 'user' as const,
    text: 'Build a grand lodge with a great hall, functional rooms, real windows, a stone accent, a clear arrival and a terrace.',
  },
];
function turn(name: string, args: unknown): ModelTurn {
  return {
    calls: [{ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
    content: null,
    truncated: false,
    usage: { inputTokens: 1, outputTokens: 1, cost: 0 },
  };
}
const results = (history: ModelMessage[]) =>
  history
    .filter((message) => message.role === 'tool')
    .map((message) => JSON.parse(String(message.content)));
const renderPair = () => {
  const response = turn('render_view', { view: 'exterior' });
  response.calls.push(...turn('render_view', { view: 'plan' }).calls);
  return response;
};
const provider: RenderProvider = async (scene, request) => {
  const { position, target } = renderCamera(scene, request);
  return {
    image: 'data:image/png;base64,iVBORw0KGgo=',
    width: 768,
    height: 576,
    sceneHash: sceneFingerprint(scene),
    view: request.view,
    camera: { position, target },
  };
};
function finish() {
  return turn('finish_design', {
    mode: 'propose',
    reply: 'The independently reviewed draft is ready.',
    assessment: 'canonical',
    visualReview: {
      status: 'passed',
      captureIds: ['capture-1', 'capture-2'],
      observations: ['Reviewed the current supplied exterior and plan.'],
    },
  });
}
function critique(ids: string[], captureIds = ['capture-1', 'capture-2']) {
  return turn('submit_design_critique', {
    intentReview: {
      status: 'adequate',
      evidence: 'Reviewed the original request, complete objectives and current supplied views.',
    },
    captureIds,
    observations: ids.map((objectiveId) => ({
      objectiveId,
      status: 'satisfactory',
      evidence: 'Reviewed current geometry and supplied views.',
    })),
  });
}

test('empty-site compose creates an unsaved scaffold and still requires current rendering and complete separate critique', async () => {
  let calls = 0;
  let critics = 0;
  const before = structuredClone(emptyScene);
  const result = await runAgent({
    scene: emptyScene,
    messages,
    context: { allowVisualReview: true },
    render: provider,
    client: {
      async complete(history, _signal, tools, ids, phase) {
        calls++;
        if (tools?.includes('submit_design_critique')) {
          critics++;
          assert.equal(phase, undefined);
          assert.ok(ids && ids.length > 1);
          return critique(ids!);
        }
        if (calls === 1) {
          assert.equal(phase, 'empty-site');
          assert.deepEqual(tools, [
            'plan_design',
            'compose_house',
            'inspect_design',
            'finish_design',
          ]);
          return turn('compose_house', { recipe: 'grand-lodge' });
        }
        if (calls === 2) {
          assert.equal(phase, undefined);
          const composed = results(history).at(-1);
          assert.equal(composed.ok, true);
          assert.equal(composed.scene, undefined);
          assert.ok(composed.quality.program);
          assert.ok(composed.plan.roomProgram.length > 3);
          return renderPair();
        }
        if (calls === 3) {
          assert.equal(phase, 'composition-review');
          const live = JSON.parse(String(history[1].content).split('\n')[1]);
          assert.equal(live.furnitureCatalog, undefined);
          assert.deepEqual(live.issues, results(history).find((item) => item.recipe)?.issues);
          return turn('critique_design', {});
        }
        assert.deepEqual(tools, [
          'review_design',
          'finish_design',
          'inspect_design',
          'resume_editing',
        ]);
        return finish();
      },
    },
  });
  assert.equal(calls, 5);
  assert.equal(critics, 1);
  assert.equal(result.metrics?.captures, 2);
  assert.equal(result.needsConfirmation, true);
  assert.ok(result.scene && result.scene.rooms.length > 3);
  assert.ok(
    result.assessment?.requirements.every(
      (item) => item.priority !== 'required' || item.status === 'fulfilled',
    ),
  );
  assert.deepEqual(emptyScene, before);
});

test('compose respects an explicit call limit without claiming an independent critique happened', async () => {
  let calls = 0;
  const result = await runAgent({
    scene: emptyScene,
    messages,
    maxCalls: 3,
    context: { allowVisualReview: true },
    render: provider,
    client: {
      async complete() {
        calls++;
        if (calls === 1) return turn('compose_house', { recipe: 'grand-lodge' });
        if (calls === 2) return renderPair();
        return finish();
      },
    },
  });
  assert.equal(result.usage.calls, 3);
  assert.match(result.reply, /Independent design critique remains unverified/);
  assert.equal(result.needsConfirmation, true);
});

test('compose cannot replace an existing house', async () => {
  const existing = { ...emptyScene, rooms: [makeRoom({ id: 'existing' })] };
  const before = structuredClone(existing);
  let calls = 0;
  const result = await runAgent({
    scene: existing,
    messages,
    context: { allowVisualReview: false },
    client: {
      async complete(history) {
        calls++;
        if (calls === 1) return turn('compose_house', { recipe: 'grand-lodge' });
        assert.match(results(history).at(-1).error, /unchanged empty site/);
        return turn('finish_design', {
          mode: 'question',
          reply: 'The existing house requires targeted edits.',
        });
      },
    },
  });
  assert.equal(result.scene, null);
  assert.deepEqual(existing, before);
});

test('a failed recipe operation batch leaves the empty draft unchanged', async () => {
  class FailedRecipeDraft extends DesignDraft {
    override apply(_operations: unknown) {
      return super.apply([
        { type: 'add_rooms', rooms: [makeRoom({ id: 'partial' })] },
        { type: 'move_group', roomIds: ['missing'], dx: 1, dz: 0 },
      ]);
    }
  }
  const draft = new FailedRecipeDraft(emptyScene);
  await assert.rejects(
    runAgent({
      scene: emptyScene,
      draft,
      messages,
      context: { allowVisualReview: false },
      client: {
        async complete() {
          return turn('compose_house', { recipe: 'grand-lodge' });
        },
      },
    }),
    /could not be applied as a valid draft/,
  );
  assert.equal(draft.changed, false);
  assert.equal(draft.scene.rooms.length, 0);
});

test('review menu resume restores genuine refinements and fresh evidence is required afterward', async () => {
  let calls = 0;
  const result = await runAgent({
    scene: emptyScene,
    messages,
    context: { allowVisualReview: true },
    render: provider,
    client: {
      async complete(history, _signal, tools, ids) {
        calls++;
        if (tools?.includes('submit_design_critique'))
          return critique(
            ids!,
            calls >= 9 ? ['capture-3', 'capture-4'] : ['capture-1', 'capture-2'],
          );
        if (calls === 1) return turn('compose_house', { recipe: 'grand-lodge' });
        if (calls === 2) return renderPair();
        if (calls === 3) return turn('critique_design', {});
        if (calls === 5) {
          assert.deepEqual(tools, [
            'review_design',
            'finish_design',
            'inspect_design',
            'resume_editing',
          ]);
          return turn('resume_editing', {});
        }
        if (calls === 6) {
          assert.equal(tools, undefined);
          const live = JSON.parse(String(history[1].content).split('\n')[1]);
          assert.ok(live.furnitureCatalog);
          const quality = JSON.parse(
            String(history[1].content)
              .split(
                'Design quality inspection (geometric proxies, not aesthetic certification):\n',
              )[1]
              .split('\n')[0],
          );
          assert.ok(
            quality.rooms.some((room: any) =>
              room.walls.some((wall: any) => Array.isArray(wall.availableWindowRectangles)),
            ),
          );
          const program = results(history).find((item) => item.recipe)?.plan.roomProgram;
          return turn('apply_operations', {
            operations: [
              {
                type: 'move_group',
                roomIds: program.map((room: any) => room.roomId),
                dx: 0.2,
                dz: 0,
              },
            ],
          });
        }
        if (calls === 7) return renderPair();
        if (calls === 8) return turn('critique_design', {});
        const response = finish();
        const args = JSON.parse(response.calls[0].function.arguments);
        args.visualReview.captureIds = ['capture-3', 'capture-4'];
        return turn('finish_design', args);
      },
    },
  });
  assert.equal(result.metrics?.captures, 4);
  assert.equal(result.usage.calls, 10);
});

test('compose cannot replace a different accepted immutable plan', async () => {
  const { composeHouseRecipe } = await import('../shared/design-recipes.ts');
  const planned = {
    ...composeHouseRecipe({ recipe: 'grand-lodge' }, messages[0].text).plan,
    intent: 'Preserve this separately accepted complete design intent.',
  };
  let calls = 0;
  const result = await runAgent({
    scene: emptyScene,
    messages,
    context: { allowVisualReview: false },
    client: {
      async complete(history) {
        calls++;
        if (calls === 1) return turn('plan_design', planned);
        if (calls === 2) return turn('compose_house', { recipe: 'grand-lodge' });
        assert.match(results(history).at(-1).error, /accepted plan is immutable/);
        return turn('finish_design', {
          mode: 'question',
          reply: 'The accepted plan requires its own targeted construction.',
          assessment: 'canonical',
        });
      },
    },
  });
  assert.equal(result.scene, null);
  assert.equal(result.plan?.intent, planned.intent);
});

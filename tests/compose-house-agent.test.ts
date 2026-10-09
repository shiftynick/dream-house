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
          assert.equal(phase, 'composition-review');
          assert.deepEqual(tools, ['render_planned_views', 'inspect_design', 'resume_editing']);
          const composed = results(history).at(-1);
          assert.equal(composed.ok, true);
          assert.equal(composed.scene, undefined);
          assert.ok(composed.quality.program);
          assert.ok(composed.plan.roomProgram.length > 3);
          return turn('render_planned_views', {});
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

test('planned macro fills the missing plan after an unrelated cutaway and returns one matching aggregate response', async () => {
  let calls = 0;
  const jobs: string[] = [];
  const result = await runAgent({
    scene: emptyScene,
    messages,
    context: { allowVisualReview: true },
    render: async (...args) => {
      jobs.push(args[1].view);
      return provider(...args);
    },
    client: {
      async complete(history, _signal, tools, ids) {
        calls++;
        if (tools?.includes('submit_design_critique'))
          return critique(ids!, ['capture-1', 'capture-3']);
        if (calls === 1) return turn('compose_house', { recipe: 'grand-lodge' });
        if (calls === 2) {
          const response = turn('render_view', { view: 'exterior' });
          response.calls.push(...turn('render_view', { view: 'cutaway' }).calls);
          return response;
        }
        if (calls === 3) return turn('critique_design', {});
        if (calls === 4) {
          assert.match(results(history).at(-1).error, /current plan/);
          return finish();
        }
        if (calls === 5) {
          assert.equal(results(history).at(-1).nextAction, 'render_planned_views');
          return turn('render_planned_views', {});
        }
        if (calls === 6) {
          const response = results(history).at(-1);
          assert.equal(response.ok, true);
          assert.deepEqual(
            response.views.map((view: any) => view.view),
            ['exterior', 'plan'],
          );
          assert.equal(response.views[0].alreadyCurrent, true);
          const assistant = [...history].reverse().find((message) => message.role === 'assistant');
          const tool = [...history].reverse().find((message) => message.role === 'tool');
          assert.equal(assistant?.tool_calls?.length, 1);
          assert.equal(tool?.tool_call_id, assistant?.tool_calls?.[0].id);
          return turn('critique_design', {});
        }
        const response = finish();
        const args = JSON.parse(response.calls[0].function.arguments);
        args.visualReview.captureIds = ['capture-1', 'capture-3'];
        return turn('finish_design', args);
      },
    },
  });
  assert.deepEqual(jobs, ['exterior', 'cutaway', 'plan']);
  assert.equal(result.metrics?.captures, 3);
  assert.equal(result.usage.calls, 8);
});

test('a partial macro render reports incomplete evidence and retries only its missing actual view', async () => {
  let calls = 0;
  let jobs = 0;
  const result = await runAgent({
    scene: emptyScene,
    messages,
    context: { allowVisualReview: true },
    render: async (...args) => {
      jobs++;
      if (jobs === 2) throw new Error('Local renderer failed.');
      return provider(...args);
    },
    client: {
      async complete(history, _signal, tools, ids) {
        calls++;
        if (tools?.includes('submit_design_critique')) return critique(ids!);
        if (calls === 1) return turn('compose_house', { recipe: 'grand-lodge' });
        if (calls === 2) return turn('render_planned_views', {});
        if (calls === 3) {
          const response = results(history).at(-1);
          assert.equal(response.ok, false);
          assert.equal(response.views[0].captureId, 'capture-1');
          assert.equal(response.views[1].ok, false);
          assert.equal(response.views[1].captureId, undefined);
          return turn('render_planned_views', {});
        }
        if (calls === 4) return turn('critique_design', {});
        return finish();
      },
    },
  });
  assert.equal(jobs, 3);
  assert.equal(result.metrics?.captures, 3);
  assert.equal(result.usage.calls, 6);
});

test('macro preflights the full missing set before spending the last capture', async () => {
  let calls = 0;
  let jobs = 0;
  await assert.rejects(
    runAgent({
      scene: emptyScene,
      messages,
      context: { allowVisualReview: true },
      render: async (...args) => {
        jobs++;
        return provider(...args);
      },
      client: {
        async complete(history) {
          calls++;
          if (calls === 1) return turn('compose_house', { recipe: 'grand-lodge' });
          if ([2, 4, 8].includes(calls)) return turn('render_planned_views', {});
          if (calls === 6) return turn('render_view', { view: 'exterior' });
          const program = results(history).find((item) => item.recipe)?.plan.roomProgram;
          return turn('apply_operations', {
            operations: [
              {
                type: 'move_group',
                roomIds: program.map((room: any) => room.roomId),
                dx: 0.1,
                dz: 0,
              },
            ],
          });
        },
      },
    }),
    /complete missing planned view set/,
  );
  assert.equal(jobs, 5);
});

test('cached planned macro images must be redelivered after separate A-to-B-to-A mutations', async () => {
  let calls = 0;
  let jobs = 0;
  let critics = 0;
  const result = await runAgent({
    scene: emptyScene,
    messages,
    context: { allowVisualReview: true },
    render: async (...args) => {
      jobs++;
      return provider(...args);
    },
    client: {
      async complete(history, _signal, tools, ids) {
        calls++;
        if (tools?.includes('submit_design_critique')) {
          critics++;
          return critique(ids!);
        }
        if (calls === 1) return turn('compose_house', { recipe: 'grand-lodge' });
        if (calls === 2) return turn('render_planned_views', {});
        if (calls === 3) {
          const program = results(history).find((item) => item.recipe)?.plan.roomProgram;
          const roomIds = program.map((room: any) => room.roomId);
          const response = turn('apply_operations', {
            operations: [{ type: 'move_group', roomIds, dx: 0.1, dz: 0 }],
          });
          response.calls[0].id = 'move-out';
          const back = turn('apply_operations', {
            operations: [{ type: 'move_group', roomIds, dx: -0.1, dz: 0 }],
          });
          back.calls[0].id = 'move-back';
          response.calls.push(
            ...back.calls,
            ...turn('render_planned_views', {}).calls,
            ...turn('critique_design', {}).calls,
          );
          return response;
        }
        if (calls === 4) {
          assert.equal(critics, 0);
          assert.match(results(history).at(-1).error, /Same-round or stale captures/);
          const macro = results(history)
            .reverse()
            .find((item) => item.requiredViews);
          assert.ok(macro.views.every((view: any) => view.reused));
          return turn('critique_design', {});
        }
        return finish();
      },
    },
  });
  assert.equal(jobs, 2);
  assert.equal(critics, 1);
  assert.equal(result.metrics?.reusedCaptures, 2);
});

test('a failed required typed program check restores the full editing menu rather than capture-only', async () => {
  let calls = 0;
  await assert.rejects(
    runAgent({
      scene: emptyScene,
      messages,
      context: { allowVisualReview: true },
      render: provider,
      client: {
        async complete(history, _signal, tools, _ids, phase) {
          calls++;
          if (calls === 1) return turn('compose_house', { recipe: 'grand-lodge' });
          if (calls === 2) {
            assert.deepEqual(tools, ['render_planned_views', 'inspect_design', 'resume_editing']);
            return turn('resume_editing', {});
          }
          if (calls === 3) {
            assert.equal(tools, undefined);
            const program = results(history).find((item) => item.recipe)?.plan.roomProgram;
            return turn('apply_operations', {
              operations: [
                {
                  type: 'update_room',
                  roomId: program.find((room: any) => room.kind === 'bedroom').roomId,
                  patch: { kind: 'hall' },
                },
              ],
            });
          }
          assert.equal(tools, undefined);
          assert.equal(phase, undefined);
          throw new Error('Confirmed failed typed check keeps full editing.');
        },
      },
    }),
    /Confirmed failed typed check/,
  );
});

test('an unchanged empty site with an all-preference plan retains construction tools', async () => {
  let calls = 0;
  const result = await runAgent({
    scene: emptyScene,
    messages,
    context: { allowVisualReview: true },
    render: provider,
    client: {
      async complete(history, _signal, tools, _ids, phase) {
        calls++;
        if (calls === 1)
          return turn('plan_design', {
            intent: 'An optional gathering room on the empty site.',
            scope: 'composition',
            roomProgram: [
              {
                roomId: 'optional-hall',
                name: 'Optional hall',
                kind: 'living',
                purpose: 'Optional gathering space',
                priority: 'preference',
              },
            ],
            materialStrategy: {
              description: 'Coordinated cedar surfaces.',
              checks: [
                {
                  kind: 'material_composition',
                  surfaces: ['exterior-walls', 'roof'],
                  allowedPalettes: ['cedar'],
                  maxDistinct: 1,
                },
              ],
            },
            fenestration: {
              description: 'Windows in the optional hall.',
              roomIds: ['optional-hall'],
            },
            reviewViews: ['exterior', 'plan'],
          });
        assert.equal(results(history).at(-1).ok, true, JSON.stringify(results(history).at(-1)));
        assert.equal(tools, undefined);
        assert.match(String(history[1].content), /apply_operations/);
        assert.notEqual(phase, 'composition-review');
        return turn('finish_design', {
          mode: 'question',
          reply: 'The site is still empty and construction remains available.',
          assessment: 'canonical',
        });
      },
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.scene, null);
  assert.equal(result.metrics?.captures, 0);
});

test('an unchanged repair preserves current needs-work critique and prose recovery finishes an honest bounded partial', async () => {
  let calls = 0;
  let jobs = 0;
  const result = await runAgent({
    scene: emptyScene,
    messages,
    maxCalls: 7,
    context: { allowVisualReview: true },
    render: async (...args) => {
      jobs++;
      return provider(...args);
    },
    client: {
      async complete(history, _signal, tools, ids) {
        calls++;
        if (tools?.includes('submit_design_critique')) {
          const response = critique(ids!);
          const submitted = JSON.parse(response.calls[0].function.arguments);
          submitted.intentReview = {
            status: 'needs_work',
            evidence: 'The arrival massing is too plain for the brief.',
          };
          const intent = submitted.observations.find(
            (item: any) => item.objectiveId === 'plan-intent',
          );
          intent.status = 'needs_repair';
          intent.repair = 'Make the arrival massing more substantial.';
          response.calls[0].function.arguments = JSON.stringify(submitted);
          return response;
        }
        if (calls === 1) return turn('compose_house', { recipe: 'grand-lodge' });
        if (calls === 2) return turn('render_planned_views', {});
        if (calls === 3) return turn('critique_design', {});
        if (calls === 5) {
          const program = results(history).find((item) => item.recipe)?.plan.roomProgram;
          return turn('apply_operations', {
            operations: [
              {
                type: 'move_group',
                roomIds: program.map((room: any) => room.roomId),
                dx: 0,
                dz: 0,
              },
            ],
          });
        }
        if (calls === 6) {
          const output = results(history).at(-1);
          assert.equal(output.sceneChanged, false);
          assert.equal(output.currentCritique.critique.intentReview.status, 'needs_work');
          assert.equal(output.remainingModelCalls, 2);
          assert.match(output.note, /did not change the scene/);
          return {
            content: 'Finishing partial.',
            calls: [],
            truncated: false,
            usage: { inputTokens: 1, outputTokens: 1, cost: 0 },
          };
        }
        assert.match(String(history.at(-1)?.content), /Text alone cannot finish/);
        return finish();
      },
    },
  });
  assert.equal(calls, 7);
  assert.equal(jobs, 2);
  assert.equal(result.needsConfirmation, true);
  assert.equal(
    result.assessment?.requirements.find((item) => item.id === 'plan-intent')?.status,
    'partial',
  );
  assert.match(result.reply, /arrival|brief|partial|unfinished/i);
});

test('prose after a real repair recovers to fresh planned captures and a new independent critique', async () => {
  let calls = 0;
  let critics = 0;
  const result = await runAgent({
    scene: emptyScene,
    messages,
    maxCalls: 10,
    context: { allowVisualReview: true },
    render: provider,
    client: {
      async complete(history, _signal, tools, ids) {
        calls++;
        if (tools?.includes('submit_design_critique')) {
          critics++;
          return critique(
            ids!,
            critics === 1 ? ['capture-1', 'capture-2'] : ['capture-3', 'capture-4'],
          );
        }
        if (calls === 1) return turn('compose_house', { recipe: 'grand-lodge' });
        if (calls === 2) return turn('render_planned_views', {});
        if (calls === 3) return turn('critique_design', {});
        if (calls === 5) {
          const program = results(history).find((item) => item.recipe)?.plan.roomProgram;
          return turn('apply_operations', {
            operations: [
              {
                type: 'move_group',
                roomIds: program.map((room: any) => room.roomId),
                dx: 0.1,
                dz: 0,
              },
            ],
          });
        }
        if (calls === 6) {
          assert.deepEqual(tools, ['render_planned_views', 'inspect_design', 'resume_editing']);
          return {
            content: 'Finishing partial.',
            calls: [],
            truncated: false,
            usage: { inputTokens: 1, outputTokens: 1, cost: 0 },
          };
        }
        if (calls === 7) {
          assert.match(
            String(history.at(-1)?.content),
            /capture phase requires render_planned_views next/,
          );
          return turn('render_planned_views', {});
        }
        if (calls === 8) return turn('critique_design', {});
        const response = finish();
        const input = JSON.parse(response.calls[0].function.arguments);
        input.visualReview.captureIds = ['capture-3', 'capture-4'];
        response.calls[0].function.arguments = JSON.stringify(input);
        return response;
      },
    },
  });
  assert.equal(calls, 10);
  assert.equal(critics, 2);
  assert.equal(result.metrics?.captures, 4);
  assert.equal(
    result.assessment?.requirements.find((item) => item.id === 'plan-intent')?.status,
    'fulfilled',
  );
});

test('near-budget prose recovery permits only an honest partial without claiming a complete review pair', async () => {
  let calls = 0;
  const result = await runAgent({
    scene: emptyScene,
    messages,
    maxCalls: 5,
    context: { allowVisualReview: true },
    render: provider,
    client: {
      async complete(history, _signal, tools) {
        calls++;
        if (calls === 1) return turn('compose_house', { recipe: 'grand-lodge' });
        if (calls === 2) return turn('render_view', { view: 'exterior' });
        if (calls === 3) {
          assert.ok(tools?.includes('finish_design'));
          return {
            content: 'Finishing partial.',
            calls: [],
            truncated: false,
            usage: { inputTokens: 1, outputTokens: 1, cost: 0 },
          };
        }
        assert.match(String(history.at(-1)?.content), /remaining budget cannot complete/);
        assert.doesNotMatch(String(history.at(-1)?.content), /requires render_planned_views next/);
        return turn('finish_design', {
          mode: 'propose',
          reply:
            'A partial draft: the layout view and independent review remain unavailable in this attempt.',
          assessment: 'canonical',
          visualReview: {
            status: 'unverified',
            captureIds: ['capture-1'],
            observations: ['Only the supplied current exterior was inspected.'],
            limitations: ['No current planned layout view or independent critic was available.'],
          },
        });
      },
    },
  });
  assert.equal(calls, 4);
  assert.equal(result.metrics?.captures, 1);
  assert.equal(result.needsConfirmation, true);
  assert.equal(
    result.assessment?.requirements.find((item) => item.id === 'plan-intent')?.status,
    'unverified',
  );
  assert.match(result.reply, /unverified|partial|independent/i);
});

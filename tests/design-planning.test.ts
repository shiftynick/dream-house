import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, gatewayAgentModel, type ModelTurn, type ModelMessage } from '../server/agent.ts';
import {
  designPlanSchema,
  designCritiqueSchema,
  planAssessment,
  plannedAssessment,
  evaluatePlan,
  compositionWindowPhase,
  type DesignPlan,
  type DesignCritique,
} from '../server/design-planning.ts';
import { DesignDraft } from '../shared/draft.ts';
import { executeCommands } from '../shared/design.ts';
import { emptyScene, makeRoom } from '../shared/model.ts';
import { renderCamera } from '../shared/render.ts';
import { sceneFingerprint, type RenderProvider } from '../server/render-service.ts';

const messages = [
  {
    id: 'owner',
    role: 'user' as const,
    text: 'Build a complete grand lodge with a coherent timber composition and real windows.',
  },
];
const rooms = [
  makeRoom({
    id: 'hall',
    name: 'Gathering hall',
    kind: 'living',
    width: 8,
    depth: 6,
    furniture: [],
  }),
  makeRoom({
    id: 'kitchen',
    name: 'Kitchen',
    kind: 'kitchen',
    x: 6,
    width: 4,
    depth: 6,
    furniture: [],
  }),
];
const plan = designPlanSchema.parse({
  intent: 'A connected gathering lodge core with a consistent timber exterior and real windows.',
  scope: 'composition',
  roomProgram: rooms.map((room) => ({
    roomId: room.id,
    name: room.name,
    kind: room.kind,
    purpose: room.name,
  })),
  materialStrategy: {
    description: 'One coordinated cedar exterior and roof.',
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
    description: 'Dimensioned exterior windows in the occupied rooms.',
    roomIds: ['hall', 'kitchen'],
    minAreaPerRoom: 1,
  },
  reviewViews: ['exterior', 'plan'],
});
const assessment = planAssessment(plan);
let nextId = 0;
function turn(name: string, args: unknown): ModelTurn {
  return {
    calls: [
      {
        id: `call-${nextId++}`,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
    content: null,
    truncated: false,
    usage: { inputTokens: 10, outputTokens: 20, cost: 0.001 },
  };
}
function build(coherent = false) {
  return turn('apply_operations', {
    operations: [
      { type: 'add_rooms', rooms },
      { type: 'connect_rooms', roomAId: 'hall', roomBId: 'kitchen' },
      ...rooms.map((room) => ({
        type: 'set_wall_openings',
        roomId: room.id,
        side: 'north',
        openings: [
          {
            id: `${room.id}-window`,
            kind: 'window',
            offset: 0,
            width: 1.5,
            height: 1.4,
            sill: 0.8,
          },
        ],
      })),
      coherent
        ? { type: 'set_material', palette: 'cedar' }
        : { type: 'set_surface_material', roomId: 'hall', surface: 'north', palette: 'cedar' },
    ],
  });
}
const renderBoth = () => {
  const result = turn('render_view', { view: 'exterior' });
  result.calls.push(...turn('render_view', { view: 'plan' }).calls);
  return result;
};
const toolResults = (history: ModelMessage[]) =>
  history
    .filter((message) => message.role === 'tool')
    .map((message) => JSON.parse(String(message.content)));
const submitted = (good: boolean, ids: string[], objectives = assessment): DesignCritique => ({
  intentReview: {
    status: good ? 'adequate' : 'needs_work',
    evidence: good
      ? 'The composition meets this planned core.'
      : 'The exterior is accidental material patchwork; coordinate it.',
    missingObjectives: [],
  },
  captureIds: ids,
  observations: objectives.requirements.map((item) => ({
    objectiveId: item.id,
    status:
      !good && ['plan-intent', 'plan-materials'].includes(item.id)
        ? 'needs_repair'
        : 'satisfactory',
    evidence:
      !good && item.id === 'plan-materials'
        ? 'Cedar is mixed with unplanned limestone.'
        : 'Checked against the current geometry and views.',
    ...(!good && ['plan-intent', 'plan-materials'].includes(item.id)
      ? { repair: 'Apply the declared cedar scheme consistently.' }
      : {}),
  })),
  limitations: [],
});
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
const finish = (history: ModelMessage[], captures = ['capture-1', 'capture-2']) => {
  const reviewed = [...toolResults(history)].reverse().find((result) => result.critique)
    ?.critique.assessment;
  return turn('finish_design', {
    mode: 'propose',
    reply: 'The lodge core is ready for review.',
    assessment: reviewed
      ? {
          requirements: reviewed.requirements.map(
            ({ verification: _v, results: _r, ...item }: any) => item,
          ),
          assumptions: reviewed.assumptions,
        }
      : {
          ...assessment,
          requirements: assessment.requirements.map((item) => ({
            ...item,
            status: 'fulfilled',
            evidence: 'Checked.',
          })),
        },
    visualReview: {
      status: 'passed',
      captureIds: captures,
      observations: ['The supplied current exterior and plan show the planned composition.'],
    },
  });
};

test('planned composition gets separate skeptical critique, refuses early partial stop, repairs and refreshes both final views', async () => {
  let calls = 0,
    critics = 0,
    admitted = 0,
    charged = 0;
  const result = await runAgent({
    scene: emptyScene,
    messages,
    maxRepairs: 0,
    context: { allowVisualReview: true },
    render: provider,
    beforeModelCall: async () => {
      admitted++;
    },
    onUsage: async () => {
      charged++;
    },
    client: {
      async complete(history, _signal, tools, criticObjectiveIds) {
        calls++;
        if (tools?.includes('submit_design_critique')) {
          critics++;
          assert.deepEqual(tools, ['submit_design_critique']);
          assert.deepEqual(
            criticObjectiveIds,
            assessment.requirements.map((item) => item.id),
          );
          assert.equal(
            history.some((message) => message.role === 'assistant' || message.role === 'tool'),
            false,
          );
          assert.equal(JSON.stringify(history).includes('BUILDER_SELF_PRAISE'), false);
          assert.ok(JSON.stringify(history).includes(messages[0].text));
          assert.equal(history.filter((message) => Array.isArray(message.content)).length, 2);
          return turn(
            'submit_design_critique',
            submitted(
              critics === 2,
              critics === 1 ? ['capture-1', 'capture-2'] : ['capture-3', 'capture-4'],
            ),
          );
        }
        if (calls === 1) {
          assert.equal(tools, undefined, 'full builder tools remain visible before planning');
          return turn('plan_design', plan);
        }
        if (calls === 2) {
          const result = build();
          result.content = 'BUILDER_SELF_PRAISE';
          return result;
        }
        if (calls === 3) return renderBoth();
        if (calls === 4 || calls === 8) return turn('critique_design', {});
        if (calls === 6) return finish(history);
        if (calls === 7) {
          assert.match(
            toolResults(history).at(-1).error,
            /Required planned objectives remain unfinished/,
          );
          const repair = turn('apply_operations', {
            operations: [{ type: 'set_material', palette: 'cedar' }],
          });
          repair.calls.push(...renderBoth().calls);
          return repair;
        }
        return finish(history, ['capture-3', 'capture-4']);
      },
    },
  });
  assert.equal(calls, 10);
  assert.equal(admitted, calls);
  assert.equal(charged, calls);
  assert.equal(result.usage.calls, calls);
  assert.equal(critics, 2);
  assert.equal(result.metrics?.captures, 4);
  assert.equal(result.scene?.palette, 'cedar');
  assert.equal(result.critique?.requiresConfirmation, false);
  assert.ok(result.assessment?.requirements.every((item) => item.status === 'fulfilled'));
});

test('planning objective request/priority/checks cannot be rewritten and target room kinds cannot borrow other rooms', () => {
  const weakened = structuredClone(assessment);
  weakened.requirements[0].request = 'Just a small core';
  weakened.requirements[0].priority = 'preference';
  weakened.requirements[1].checks = [];
  const retained = plannedAssessment(assessment, weakened);
  assert.equal(retained.requirements[0].request, assessment.requirements[0].request);
  assert.equal(retained.requirements[0].priority, 'required');
  assert.deepEqual(retained.requirements[1].checks, assessment.requirements[1].checks);
  const wrongProgram = {
    ...emptyScene,
    rooms: [
      rooms[0],
      { ...rooms[1], kind: 'hall' as const },
      makeRoom({ id: 'unplanned-kitchen', kind: 'kitchen', x: 12, width: 4 }),
    ],
  };
  const evaluated = evaluatePlan(wrongProgram, assessment, emptyScene);
  const programObjective = evaluated.requirements.find((item) =>
    item.checks.some((check) => check.kind === 'room_program' && check.roomKind === 'kitchen'),
  )!;
  const kitchenIndex = programObjective.checks.findIndex(
    (check) => check.kind === 'room_program' && check.roomKind === 'kitchen',
  );
  assert.equal(programObjective.results[kitchenIndex].passed, false);
  assert.throws(
    () =>
      designPlanSchema.parse({
        ...plan,
        features: Array.from({ length: 6 }, (_, index) => ({
          id: `extra-${index}`,
          request: `Feature ${index}`,
        })),
      }),
    /eight assessment objectives/,
  );
});

test('critic feedback needs a later builder round, and insufficient reserved calls skip the critic', async () => {
  let calls = 0;
  const result = await runAgent({
    scene: emptyScene,
    messages,
    maxRepairs: 0,
    client: {
      async complete(history, _signal, tools) {
        calls++;
        if (tools?.includes('submit_design_critique'))
          return turn('submit_design_critique', submitted(true, []));
        if (calls === 1) return turn('plan_design', plan);
        if (calls === 2) return build(true);
        if (calls === 3) {
          const combined = turn('critique_design', {});
          const stop = finish(history);
          const args = JSON.parse(stop.calls[0].function.arguments);
          delete args.visualReview;
          stop.calls[0].function.arguments = JSON.stringify(args);
          combined.calls.push(...stop.calls);
          return combined;
        }
        assert.match(toolResults(history).at(-1).error, /next builder model round/);
        const stop = finish(history);
        const args = JSON.parse(stop.calls[0].function.arguments);
        delete args.visualReview;
        stop.calls[0].function.arguments = JSON.stringify(args);
        return stop;
      },
    },
  });
  assert.equal(result.usage.calls, 5);
  let reservedCalls = 0,
    critics = 0;
  await assert.rejects(
    runAgent({
      scene: emptyScene,
      messages,
      maxCalls: 3,
      client: {
        async complete(_history, _signal, tools) {
          reservedCalls++;
          if (tools?.includes('submit_design_critique')) critics++;
          if (reservedCalls === 1) return turn('plan_design', plan);
          if (reservedCalls === 2) return build(true);
          return turn('critique_design', {});
        },
      },
    }),
    /model-call limit/,
  );
  assert.equal(reservedCalls, 3);
  assert.equal(critics, 0);
});

test('a composition cannot substitute focused room captures for whole-house exterior and layout evidence', async () => {
  let calls = 0,
    critics = 0;
  await assert.rejects(
    runAgent({
      scene: emptyScene,
      messages,
      maxCalls: 4,
      context: { allowVisualReview: true },
      render: provider,
      client: {
        async complete(_history, _signal, tools) {
          calls++;
          if (tools?.includes('submit_design_critique')) critics++;
          if (calls === 1) return turn('plan_design', plan);
          if (calls === 2) return build(true);
          if (calls === 3) {
            const scoped = turn('render_view', { view: 'exterior', roomId: 'hall' });
            scoped.calls.push(...turn('render_view', { view: 'plan', roomId: 'hall' }).calls);
            return scoped;
          }
          return turn('critique_design', {});
        },
      },
    }),
    /model-call limit/,
  );
  assert.equal(calls, 4);
  assert.equal(critics, 0);
});

test('critic additions expose an underplanned original request and budget-limited proposal retains them', async () => {
  let calls = 0;
  const result = await runAgent({
    scene: emptyScene,
    messages,
    maxCalls: 8,
    maxRepairs: 0,
    client: {
      async complete(history, _signal, tools) {
        calls++;
        if (tools?.includes('submit_design_critique')) {
          const value = submitted(true, []);
          value.intentReview = {
            status: 'needs_work',
            evidence: 'A grand lodge needs sleeping accommodation beyond this tiny core.',
            missingObjectives: [
              {
                id: 'critic-sleeping',
                request: 'Include lodge sleeping accommodation.',
                checks: [{ kind: 'room_program', roomKind: 'bedroom', minCount: 1 }],
              },
            ],
          };
          return turn('submit_design_critique', value);
        }
        if (calls === 1) return turn('plan_design', plan);
        if (calls === 2) return build(true);
        if (calls === 3) return turn('critique_design', {});
        if (calls === 6)
          assert.match(
            toolResults(history).at(-1).error,
            /Required planned objectives remain unfinished/,
          );
        const stop = finish(history);
        const args = JSON.parse(stop.calls[0].function.arguments);
        delete args.visualReview;
        stop.calls[0].function.arguments = JSON.stringify(args);
        return stop;
      },
    },
  });
  assert.equal(calls, 6);
  assert.equal(result.needsConfirmation, true);
  assert.notEqual(
    result.assessment?.requirements.find((item) => item.id === 'critic-sleeping')?.status,
    'fulfilled',
  );
  assert.match(result.reply, /sleeping accommodation/);
});

test('unplanned empty-site ops and focused multiroom loophole fail before changes without consuming geometry repair allowance', async () => {
  const draft = new DesignDraft(emptyScene);
  let calls = 0;
  const result = await runAgent({
    scene: emptyScene,
    draft,
    messages,
    maxRepairs: 0,
    client: {
      async complete(history) {
        calls++;
        assert.equal(draft.changed, false);
        if (calls === 1) return build();
        if (calls === 2) {
          assert.match(toolResults(history).at(-1).error, /Call plan_design/);
          return turn('plan_design', { ...plan, scope: 'focused' });
        }
        assert.match(toolResults(history).at(-1).error, /composition plan/);
        return turn('finish_design', {
          mode: 'question',
          questionReason: 'clarification',
          reply: 'Please clarify the intended program.',
        });
      },
    },
  });
  assert.equal(result.scene, null);
  assert.equal(calls, 3);
});

test('critic calls stay inside actual model budget and cannot execute builder tools', async () => {
  let calls = 0,
    admitted = 0;
  const draft = new DesignDraft(emptyScene);
  await assert.rejects(
    runAgent({
      scene: emptyScene,
      draft,
      messages,
      maxCalls: 5,
      beforeModelCall: async () => {
        admitted++;
      },
      client: {
        async complete(_history, _signal, tools) {
          calls++;
          if (tools?.includes('submit_design_critique')) return turn('reset_draft', {});
          if (calls === 1) return turn('plan_design', plan);
          if (calls === 2) return build(true);
          return turn('critique_design', {});
        },
      },
    }),
    /model-call limit/,
  );
  assert.equal(calls, 5);
  assert.equal(admitted, 5);
  assert.equal(draft.scene.palette, 'cedar', 'illegal critic reset was never executed');
});

test('disabled visual review sends no critic pixels and allows an honest visibility-limited proposal', async () => {
  let calls = 0;
  const result = await runAgent({
    scene: emptyScene,
    messages,
    context: { allowVisualReview: false, image: 'data:image/png;base64,iVBORw0KGgo=' },
    render: async () => {
      throw new Error('Privacy disabled rendering');
    },
    client: {
      async complete(history, _signal, tools) {
        calls++;
        assert.ok(
          history.every(
            (message) =>
              !Array.isArray(message.content) ||
              message.content.every((part) => part.type !== 'image_url'),
          ),
        );
        if (tools?.includes('submit_design_critique')) {
          const value = submitted(true, []);
          value.observations[0] = {
            objectiveId: 'plan-intent',
            status: 'unverified',
            evidence: 'Visual massing is not visible.',
            limitation: 'Image sharing is disabled; visual coherence is unverified.',
            constraint: 'visibility',
          };
          return turn('submit_design_critique', value);
        }
        if (calls === 1) return turn('plan_design', plan);
        if (calls === 2) return build(true);
        if (calls === 3) return turn('critique_design', {});
        const value = finish(history);
        const args = JSON.parse(value.calls[0].function.arguments);
        delete args.visualReview;
        value.calls[0].function.arguments = JSON.stringify(args);
        return value;
      },
    },
  });
  assert.equal(result.needsConfirmation, true);
  assert.equal(result.critique?.assessment.requirements[0].status, 'unverified');
  assert.equal(result.metrics?.imageBytesSent, 0);
  assert.match(result.reply, /Image sharing is disabled/);
});

test('gateway critic subset excludes all builder editing tools', async () => {
  const model = gatewayAgentModel('synthetic', 'synthetic', (async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    assert.deepEqual(
      request.tools.map((tool: any) => tool.function.name),
      ['submit_design_critique'],
    );
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              tool_calls: turn('submit_design_critique', submitted(true, [])).calls,
            },
          },
        ],
      }),
      { status: 200 },
    );
  }) as typeof fetch);
  const result = await model.complete(
    [{ role: 'system', content: 'Independent test critic' }],
    undefined,
    ['submit_design_critique'],
  );
  assert.equal(result.calls[0].function.name, 'submit_design_critique');
});

test('disabled pixels cannot excuse failed supported material checks as visibility-only while calls remain', async () => {
  let calls = 0;
  const result = await runAgent({
    scene: emptyScene,
    messages,
    maxCalls: 9,
    maxRepairs: 0,
    context: { allowVisualReview: false },
    client: {
      async complete(history, _signal, tools) {
        calls++;
        if (tools?.includes('submit_design_critique')) {
          const value = submitted(true, []);
          value.intentReview.status = 'unverified';
          value.observations = value.observations.map((item) =>
            ['plan-intent', 'plan-materials'].includes(item.objectiveId)
              ? {
                  ...item,
                  status: 'unverified',
                  constraint: 'visibility',
                  limitation: 'The image is unavailable.',
                }
              : item,
          );
          return turn('submit_design_critique', value);
        }
        if (calls === 1) return turn('plan_design', plan);
        if (calls === 2) return build(false);
        if (calls === 3) return turn('critique_design', {});
        if (calls > 5)
          assert.match(
            toolResults(history).at(-1).error,
            /Required planned objectives remain unfinished/,
          );
        const stop = finish(history);
        const args = JSON.parse(stop.calls[0].function.arguments);
        delete args.visualReview;
        stop.calls[0].function.arguments = JSON.stringify(args);
        return stop;
      },
    },
  });
  assert.equal(
    calls,
    7,
    'two early stops are refused before the actual remaining-call budget becomes limiting',
  );
  assert.equal(result.needsConfirmation, true);
  assert.ok(
    result.assessment?.requirements
      .find((item) => item.id === 'plan-materials')
      ?.results.some((item) => !item.passed),
  );
});

test('abort during independent critic usage accounting prevents publication and any later builder call', async () => {
  const controller = new AbortController();
  let calls = 0,
    charged = 0;
  const draft = new DesignDraft(emptyScene);
  await assert.rejects(
    runAgent({
      scene: emptyScene,
      draft,
      messages,
      signal: controller.signal,
      onUsage: async () => {
        if (++charged === 4) controller.abort();
      },
      client: {
        async complete(_history, _signal, tools) {
          calls++;
          if (tools?.includes('submit_design_critique'))
            return turn('submit_design_critique', submitted(true, []));
          if (calls === 1) return turn('plan_design', plan);
          if (calls === 2) return build(true);
          return turn('critique_design', {});
        },
      },
    }),
    /abort/i,
  );
  assert.equal(calls, 4);
  assert.equal(charged, 4);
  assert.equal(emptyScene.rooms.length, 0);
});

test('invalid empty-site plan exposes available editing tools and cannot end by falsely asking to enable them', async () => {
  let calls = 0;
  const result = await runAgent({
    scene: emptyScene,
    messages,
    maxRepairs: 0,
    client: {
      async complete(history, _signal, tools) {
        calls++;
        if (tools?.includes('submit_design_critique'))
          return turn('submit_design_critique', submitted(true, []));
        assert.equal(tools, undefined, 'builder always receives the complete editing menu');
        assert.match(
          String(history[1].content),
          /All editing tools are available|no additional editing permission/,
        );
        if (calls === 1) return turn('plan_design', { ...plan, materialStrategy: undefined });
        if (calls === 2) {
          const feedback = toolResults(history).at(-1);
          assert.ok(feedback.issues.some((issue: any) => issue.path.includes('materialStrategy')));
          assert.ok(feedback.availableTools.includes('apply_operations'));
          assert.ok(feedback.availableTools.includes('render_view'));
          assert.equal(feedback.availableTools.includes('submit_design_critique'), false);
          assert.match(feedback.nextStep, /Correct plan_design/);
          return turn('finish_design', {
            mode: 'question',
            questionReason: 'tools_unavailable',
            reply: 'Please enable editing tools before I can build.',
          });
        }
        if (calls === 3) {
          assert.match(toolResults(history).at(-1).error, /All editing tools are available/);
          return turn('plan_design', plan);
        }
        if (calls === 4) return build(true);
        if (calls === 5) return turn('critique_design', {});
        const stop = finish(history);
        const args = JSON.parse(stop.calls[0].function.arguments);
        delete args.visualReview;
        stop.calls[0].function.arguments = JSON.stringify(args);
        return stop;
      },
    },
  });
  assert.equal(calls, 7);
  assert.equal(result.scene?.rooms.length, 2);
  assert.ok(result.critique);
});

test('a genuine empty-site clarification can still finish immediately without a plan', async () => {
  let calls = 0;
  const result = await runAgent({
    scene: emptyScene,
    messages: [{ ...messages[0], text: 'Build a home using the conflicting two brief options.' }],
    client: {
      async complete() {
        calls++;
        return turn('finish_design', {
          mode: 'question',
          questionReason: 'clarification',
          reply: 'Which of the two conflicting room programs should I use?',
        });
      },
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.scene, null);
  assert.match(result.reply, /conflicting room programs/);
});

test('window phase uses the complete candidate, ignores optional rooms, and catches equal-count replacements/conversions', () => {
  const full = executeCommands(
    emptyScene,
    JSON.parse(build(true).calls[0].function.arguments).operations,
  ).scene;
  const partial = { ...full, rooms: [full.rooms[0]], design: undefined };
  assert.ok(compositionWindowPhase(emptyScene, partial, assessment, emptyScene));
  assert.equal(compositionWindowPhase(emptyScene, full, assessment, emptyScene), undefined);
  const optionalPlan = designPlanSchema.parse({
    ...plan,
    roomProgram: [
      ...plan.roomProgram,
      {
        roomId: 'optional-terrace',
        name: 'Optional terrace',
        kind: 'terrace',
        purpose: 'Optional outdoor space',
        priority: 'preference',
      },
    ],
  });
  assert.equal(
    compositionWindowPhase(emptyScene, full, planAssessment(optionalPlan), emptyScene),
    undefined,
  );
  const replaced = structuredClone(partial);
  replaced.rooms[0].wallOpenings![0].id = 'replacement-window';
  assert.ok(compositionWindowPhase(partial, replaced, assessment, emptyScene));
  const door = structuredClone(partial);
  door.rooms[0].wallOpenings![0].kind = 'door';
  assert.ok(compositionWindowPhase(door, partial, assessment, emptyScene));
  const wrongKind = structuredClone(full);
  wrongKind.rooms[1].kind = 'hall';
  assert.ok(compositionWindowPhase(emptyScene, wrongKind, assessment, emptyScene));
  assert.throws(
    () => designPlanSchema.parse({ ...plan, reviewViews: ['exterior', 'plan', 'cutaway'] }),
    /exactly two/,
  );
});

test('premature window batch rolls back entirely and preserves previously delivered current capture pixels', async () => {
  let calls = 0;
  const draft = new DesignDraft(emptyScene);
  const result = await runAgent({
    scene: emptyScene,
    draft,
    messages,
    maxRepairs: 0,
    context: { allowVisualReview: true },
    render: provider,
    client: {
      async complete(history, _signal, tools) {
        calls++;
        if (tools?.includes('submit_design_critique'))
          return turn('submit_design_critique', submitted(true, ['capture-1', 'capture-2']));
        if (calls === 1) return turn('plan_design', plan);
        if (calls === 2) return build(true);
        if (calls === 3) return renderBoth();
        if (calls === 4)
          return turn('apply_operations', {
            operations: [
              { type: 'remove_objects', ids: ['kitchen'] },
              {
                type: 'set_wall_openings',
                roomId: 'hall',
                side: 'north',
                openings: [
                  {
                    id: 'replacement',
                    kind: 'window',
                    offset: 0,
                    width: 2,
                    height: 1.4,
                    sill: 0.8,
                  },
                ],
              },
            ],
          });
        if (calls === 5) {
          assert.equal(toolResults(history).at(-1).phase, 'required_room_shell');
          assert.equal(draft.scene.rooms.length, 2);
          assert.equal(draft.scene.rooms[0].wallOpenings![0].id, 'hall-window');
          assert.equal(
            history.filter(
              (message) =>
                Array.isArray(message.content) &&
                message.content.some((part) => part.type === 'image_url'),
            ).length,
            2,
          );
          return turn('critique_design', {});
        }
        return finish(history);
      },
    },
  });
  assert.equal(result.critique?.requiresConfirmation, false);
  assert.equal(result.metrics?.captures, 2);
  assert.equal(calls, 7);
});

test('composition phase preflight permits repairs from an overlapping scratch shell', async () => {
  let calls = 0;
  const draft = new DesignDraft(emptyScene);
  const result = await runAgent({
    scene: emptyScene,
    draft,
    messages,
    maxRepairs: 1,
    client: {
      async complete(history, _signal, tools) {
        calls++;
        if (tools?.includes('submit_design_critique'))
          return turn('submit_design_critique', submitted(true, []));
        if (calls === 1) return turn('plan_design', plan);
        if (calls === 2)
          return turn('apply_operations', {
            operations: [{ type: 'add_rooms', rooms: [rooms[0], { ...rooms[1], x: 0 }] }],
          });
        if (calls === 3) {
          assert.ok(draft.issues.some((issue) => issue.severity === 'error'));
          const complete = JSON.parse(build(true).calls[0].function.arguments).operations.slice(1);
          return turn('apply_operations', {
            operations: [{ type: 'move_group', roomIds: ['kitchen'], dx: 6, dz: 0 }, ...complete],
          });
        }
        if (calls === 4) return turn('critique_design', {});
        const stop = finish(history);
        const args = JSON.parse(stop.calls[0].function.arguments);
        delete args.visualReview;
        stop.calls[0].function.arguments = JSON.stringify(args);
        return stop;
      },
    },
  });
  assert.equal(result.scene?.rooms[1].x, 6);
  assert.equal(
    result.issues.some((issue) => issue.severity === 'error'),
    false,
  );
});

test('critic evidence has a bounded larger allowance and invalid schema feedback reaches only the next independent critic', async () => {
  const exact = submitted(true, []);
  exact.intentReview.evidence = 'e'.repeat(1000);
  exact.observations[0].evidence = 'e'.repeat(1000);
  assert.ok(designCritiqueSchema.safeParse(exact).success);
  exact.observations[0].evidence += 'e';
  assert.equal(designCritiqueSchema.safeParse(exact).success, false);
  let calls = 0;
  let critics = 0;
  const result = await runAgent({
    scene: emptyScene,
    messages,
    maxRepairs: 0,
    client: {
      async complete(history, _signal, tools) {
        calls++;
        if (tools?.includes('submit_design_critique')) {
          critics++;
          const context = JSON.parse(String(history[1].content));
          assert.equal(
            history.some((message) => message.role === 'assistant'),
            false,
          );
          const response = submitted(true, []);
          if (critics === 1) {
            assert.equal(context.previousSubmissionValidation, undefined);
            response.intentReview.evidence = 'PRIVATE INVALID CRITIC PROSE '.repeat(50);
          } else {
            assert.deepEqual(
              context.previousSubmissionValidation.issues.map((issue: any) => issue.path),
              ['intentReview.evidence'],
            );
            assert.match(context.previousSubmissionValidation.issues[0].message, /1000/);
            assert.equal(JSON.stringify(history).includes('PRIVATE INVALID CRITIC PROSE'), false);
            response.intentReview.evidence = 'i'.repeat(700);
            response.observations[0].evidence = 'o'.repeat(700);
          }
          return turn('submit_design_critique', response);
        }
        if (calls === 1) return turn('plan_design', plan);
        if (calls === 2) return build(true);
        if (calls === 3 || calls === 5) return turn('critique_design', {});
        const stop = finish(history);
        const args = JSON.parse(stop.calls[0].function.arguments);
        delete args.visualReview;
        stop.calls[0].function.arguments = JSON.stringify(args);
        return stop;
      },
    },
  });
  assert.equal(calls, 7);
  assert.equal(critics, 2);
  assert.equal(result.critique?.critique.intentReview.evidence.length, 700);
  assert.equal(result.critique?.critique.observations[0].evidence.length, 700);
  assert.equal(result.critique?.assessment.requirements[0].evidence.length, 500);
});

test('accepted composition defaults to twenty actual calls while explicit twelve stays strict', async () => {
  const run = async (maxCalls?: number) => {
    let calls = 0;
    let critics = 0;
    const promise = runAgent({
      scene: emptyScene,
      messages,
      maxCalls,
      context: { allowVisualReview: true },
      render: provider,
      client: {
        async complete(history, _signal, tools) {
          calls++;
          if (tools?.includes('submit_design_critique')) {
            critics++;
            return turn('submit_design_critique', submitted(true, ['capture-1', 'capture-2']));
          }
          if (calls === 1) return turn('plan_design', plan);
          if (calls === 2) return build(true);
          if (calls <= 14)
            return turn('apply_operations', {
              operations: [{ type: 'move_group', roomIds: ['hall', 'kitchen'], dx: 0.1, dz: 0 }],
            });
          if (calls === 15) return renderBoth();
          if (calls === 16) return turn('critique_design', {});
          return finish(history);
        },
      },
    });
    if (maxCalls === 12) {
      await assert.rejects(promise, /model-call limit/);
      assert.equal(calls, 12);
      assert.equal(critics, 0);
    } else {
      const result = await promise;
      assert.equal(calls, 18);
      assert.equal(result.usage.calls, 18);
      assert.equal(critics, 1);
      assert.equal(result.critique?.requiresConfirmation, false);
      assert.equal(result.metrics?.captures, 2);
    }
  };
  await run();
  await run(12);
});

test('planned composition permits an initial review pair and two fresh repair pairs with current critiques', async () => {
  let calls = 0;
  let critics = 0;
  const result = await runAgent({
    scene: emptyScene,
    messages,
    maxRepairs: 0,
    context: { allowVisualReview: true },
    render: provider,
    client: {
      async complete(history, _signal, tools) {
        calls++;
        if (tools?.includes('submit_design_critique')) {
          critics++;
          return turn(
            'submit_design_critique',
            submitted(true, [`capture-${2 * critics - 1}`, `capture-${2 * critics}`]),
          );
        }
        if (calls === 1) return turn('plan_design', plan);
        if (calls === 2) return build(true);
        if (calls === 3) return renderBoth();
        if ([4, 7, 10].includes(calls)) return turn('critique_design', {});
        if ([6, 9].includes(calls)) {
          const repair = turn('apply_operations', {
            operations: [{ type: 'set_roof', style: 'pitched', pitch: calls === 6 ? 12 : 13 }],
          });
          repair.calls.push(...renderBoth().calls);
          return repair;
        }
        return finish(history, ['capture-5', 'capture-6']);
      },
    },
  });
  assert.equal(result.metrics?.captures, 6);
  assert.equal(critics, 3);
  assert.equal(result.usage.calls, 12);
  assert.deepEqual(result.visualReview?.captureIds, ['capture-5', 'capture-6']);
});

test('planned capture budget remains hard bounded at six distinct images', async () => {
  let calls = 0;
  let rendered = 0;
  await assert.rejects(
    runAgent({
      scene: emptyScene,
      messages,
      context: { allowVisualReview: true },
      render: async (...args) => {
        rendered++;
        return provider(...args);
      },
      client: {
        async complete() {
          calls++;
          if (calls === 1) return turn('plan_design', plan);
          if (calls === 2) return build(true);
          if (calls === 3) {
            const captures = turn('render_view', { view: 'exterior', angle: 'southeast' });
            for (const angle of ['southeast', 'southwest', 'northeast']) {
              if (angle !== 'southeast')
                captures.calls.push(...turn('render_view', { view: 'exterior', angle }).calls);
              captures.calls.push(...turn('render_view', { view: 'plan', angle }).calls);
            }
            return captures;
          }
          return turn('render_view', { view: 'exterior', angle: 'northwest' });
        },
      },
    }),
    /six-image review limit/,
  );
  assert.equal(rendered, 6);
});

test('finish feedback routes a ready delivered pair directly to critique without spending more captures', async () => {
  let calls = 0;
  const result = await runAgent({
    scene: emptyScene,
    messages,
    maxCalls: 7,
    maxRepairs: 0,
    context: { allowVisualReview: true },
    render: provider,
    client: {
      async complete(history, _signal, tools) {
        calls++;
        if (tools?.includes('submit_design_critique'))
          return turn('submit_design_critique', submitted(true, ['capture-1', 'capture-2']));
        if (calls === 1) return turn('plan_design', plan);
        if (calls === 2) return build(true);
        if (calls === 3) return renderBoth();
        if (calls === 4) return finish(history);
        if (calls === 5) {
          assert.match(
            toolResults(history).at(-1).error,
            /Current paired views are ready; call critique_design next/,
          );
          assert.match(toolResults(history).at(-1).error, /No additional render is needed/);
          return turn('critique_design', {});
        }
        const final = finish(history);
        const args = JSON.parse(final.calls[0].function.arguments);
        args.assessment = 'canonical';
        return turn('finish_design', args);
      },
    },
  });
  assert.equal(result.usage.calls, 7);
  assert.equal(result.metrics?.captures, 2);
  assert.equal(
    result.assessment?.requirements.find((item) => item.id === 'plan-intent')?.status,
    'fulfilled',
  );
});

test('ready review pair does not force a critic when its next builder, critic and finish calls cannot fit', async () => {
  let calls = 0;
  const result = await runAgent({
    scene: emptyScene,
    messages,
    maxCalls: 6,
    maxRepairs: 0,
    context: { allowVisualReview: true },
    render: provider,
    client: {
      async complete(history) {
        calls++;
        if (calls === 1) return turn('plan_design', plan);
        if (calls === 2) return build(true);
        if (calls === 3) return renderBoth();
        return finish(history);
      },
    },
  });
  assert.equal(result.usage.calls, 4);
  assert.equal(result.needsConfirmation, true);
  assert.match(result.reply, /Independent design critique remains unverified/);
});

test('cached A-to-B-to-A capture IDs cannot enter critique until a later builder delivery round', async () => {
  let calls = 0,
    critics = 0,
    renders = 0;
  const result = await runAgent({
    scene: emptyScene,
    messages,
    context: { allowVisualReview: true },
    render: async (...args) => {
      renders++;
      return provider(...args);
    },
    client: {
      async complete(history, _signal, tools) {
        calls++;
        if (tools?.includes('submit_design_critique')) {
          critics++;
          assert.equal(calls, 6, 'critic must wait for the cached image delivery builder round');
          return turn('submit_design_critique', submitted(true, ['capture-1', 'capture-2']));
        }
        if (calls === 1) return turn('plan_design', plan);
        if (calls === 2) return build(true);
        if (calls === 3) return renderBoth();
        if (calls === 4) {
          const batch = turn('apply_operations', {
            operations: [{ type: 'set_material', palette: 'chalk' }],
          });
          batch.calls.push(
            ...turn('apply_operations', {
              operations: [{ type: 'set_material', palette: 'cedar' }],
            }).calls,
            ...renderBoth().calls,
            ...turn('critique_design', {}).calls,
          );
          return batch;
        }
        if (calls === 5) {
          assert.equal(critics, 0, 'same-turn cached request must not invoke a critic');
          assert.match(toolResults(history).at(-1).error, /Same-round or stale captures/);
          const budget = JSON.parse(String(history[2].content).split('\n')[1]);
          assert.deepEqual(
            budget.missingCurrentCritiqueViews,
            [],
            'upcoming builder call receives the pending images',
          );
          assert.equal(
            history.filter(
              (message) =>
                Array.isArray(message.content) &&
                message.content.some((part) => part.type === 'image_url'),
            ).length,
            2,
          );
          return turn('critique_design', {});
        }
        return finish(history);
      },
    },
  });
  assert.equal(calls, 7);
  assert.equal(critics, 1);
  assert.equal(renders, 2, 'cached rehydration must not spend another renderer capture');
  assert.equal(result.metrics?.reusedCaptures, 2);
  assert.deepEqual(result.critique?.critique.captureIds, ['capture-1', 'capture-2']);
});

test('oversized plan feedback budgets generated objectives and keeps the intended room program', async () => {
  let calls = 0;
  const oversized = {
    ...plan,
    features: Array.from({ length: 6 }, (_, index) => ({
      id: `extra-${index}`,
      request: `Feature ${index}`,
    })),
  };
  const result = await runAgent({
    scene: emptyScene,
    messages,
    maxCalls: 4,
    maxRepairs: 0,
    context: { allowVisualReview: false },
    client: {
      async complete(history) {
        calls++;
        if (calls === 1) return turn('plan_design', oversized);
        if (calls === 2) {
          const feedback = toolResults(history).at(-1);
          assert.deepEqual(feedback.objectiveBudget, {
            maximumInitialObjectives: 8,
            automaticObjectives: 4,
            maximumFeatureObjectives: 4,
            suppliedFeatureObjectives: 6,
          });
          assert.match(feedback.planRepair, /instead of dropping rooms/);
          return turn('plan_design', plan);
        }
        if (calls === 3) return build(true);
        return turn('finish_design', {
          mode: 'propose',
          reply: 'A partial composition for review.',
          assessment: 'canonical',
        });
      },
    },
  });
  assert.equal(result.scene?.rooms.length, plan.roomProgram.length);
  assert.ok(
    result.assessment?.requirements.some((item) =>
      item.checks.some((check) => check.kind === 'room_exists' && check.roomId === 'kitchen'),
    ),
  );
});

test('default planned twenty-call bound and focused twelve-call bound remain hard limits', async () => {
  for (const composition of [true, false]) {
    let calls = 0;
    await assert.rejects(
      runAgent({
        scene: composition ? emptyScene : { ...emptyScene, rooms },
        messages,
        context: { allowVisualReview: false },
        client: {
          async complete() {
            calls++;
            if (composition && calls === 1) return turn('plan_design', plan);
            if (composition && calls === 2) return build(true);
            return turn('apply_operations', {
              operations: [{ type: 'move_group', roomIds: ['hall', 'kitchen'], dx: 0.1, dz: 0 }],
            });
          },
        },
      }),
      /model-call limit/,
    );
    assert.equal(calls, composition ? 20 : 12);
  }
});

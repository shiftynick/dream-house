// Opt-in model evaluations. Synthetic scenes and previewOnly never enter saved history.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { AGENT_LIMITS } from '../server/agent.ts';
import { circulationEdges, executeCommands, validateDesignChange } from '../shared/design.ts';
import { bounds, sharedBoundary } from '../shared/geometry.ts';
import {
  agentResponseSchema,
  emptyScene,
  makeRoom,
  type Room,
  type Scene,
} from '../shared/model.ts';
import type { AgentContext, HarnessResult } from '../shared/harness.ts';

type Case = {
  scene: Scene;
  prompt: string;
  context?: AgentContext;
  verify: (scene: Scene) => void;
};
type CaseName = 'attach' | 'selected' | 'empty' | 'resize';
const caseNames: CaseName[] = ['selected', 'attach', 'empty', 'resize'];
const room = (scene: Scene, id: string) => {
  const found = scene.rooms.find((candidate) => candidate.id === id);
  assert.ok(found, `Expected the existing room ${id} to retain its ID.`);
  return found;
};
const sameRoomIds = (before: Scene, after: Scene) =>
  assert.deepEqual(
    after.rooms.map((r) => r.id).sort(),
    before.rooms.map((r) => r.id).sort(),
    'Room IDs and count must be preserved.',
  );
const connected = (scene: Scene, a: string, b: string) =>
  assert.ok(
    circulationEdges(scene).some(([x, y]) => (x === a && y === b) || (x === b && y === a)),
    `${a} and ${b} need an aligned indoor passage.`,
  );
const geometry = (r: Room) => ({
  x: r.x,
  z: r.z,
  elevation: r.elevation,
  width: r.width,
  depth: r.depth,
  height: r.height,
});
function prepare(scene: Scene, operations: unknown): Scene {
  const result = executeCommands(scene, operations);
  assert.ok(result.applied, result.issues.map((issue) => issue.message).join(' '));
  return result.scene;
}
function makeCase(name: CaseName): Case {
  if (name === 'empty')
    return {
      scene: structuredClone(emptyScene),
      prompt:
        'Create a tiny one-story house with exactly two rooms: a living room 6 meters wide and 5 meters deep, centered at x=0 and z=0, and a kitchen 4 meters wide and 5 meters deep directly east of it. Connect them with an indoor doorway through their shared wall. Both floors are at ground level and rooms are 3.2 meters tall. Flat site, flat roof, limestone palette, no stairs or fireplace. Make reasonable defaults and finish the design without asking a question.',
      verify(scene) {
        assert.equal(scene.rooms.length, 2);
        const living = scene.rooms.find((r) => r.kind === 'living'),
          kitchen = scene.rooms.find((r) => r.kind === 'kitchen');
        assert.ok(living && kitchen, 'The house needs one living room and one kitchen.');
        assert.deepEqual(geometry(living), {
          x: 0,
          z: 0,
          width: 6,
          depth: 5,
          elevation: 0,
          height: 3.2,
        });
        assert.deepEqual(geometry(kitchen), {
          x: 5,
          z: 0,
          width: 4,
          depth: 5,
          elevation: 0,
          height: 3.2,
        });
        connected(scene, living.id, kitchen.id);
        assert.equal(sharedBoundary(living, kitchen)?.sideA, 'east');
        assert.equal(scene.slope, 0);
        assert.equal(scene.roof, 'flat');
        assert.equal(scene.palette, 'limestone');
        assert.equal(scene.stairs.length, 0);
        assert.equal(scene.fireplace, null);
      },
    };

  if (name === 'selected') {
    const scene = prepare(
      {
        ...structuredClone(emptyScene),
        slope: 0,
        rooms: [
          makeRoom({
            id: 'kitchen',
            name: 'Kitchen',
            kind: 'kitchen',
            x: -3,
            z: 0,
            width: 6,
            depth: 5,
          }),
          makeRoom({
            id: 'living',
            name: 'Living room',
            kind: 'living',
            x: 3,
            z: 0,
            width: 6,
            depth: 5,
          }),
        ],
      },
      [{ type: 'connect_rooms', roomAId: 'kitchen', roomBId: 'living' }],
    );
    return {
      scene,
      context: {
        selectedRoomId: 'kitchen',
        view: 'orbit',
        camera: { position: [12, 10, 14], target: [0, 1, 0] },
      },
      prompt:
        'Give this room the cedar palette. Keep the other room and all geometry exactly as they are.',
      verify(result) {
        sameRoomIds(scene, result);
        assert.equal(room(result, 'kitchen').palette, 'cedar');
        assert.deepEqual(
          { ...room(result, 'kitchen'), palette: undefined },
          { ...room(scene, 'kitchen'), palette: undefined },
        );
        assert.deepEqual(room(result, 'living'), room(scene, 'living'));
        assert.equal(
          result.palette,
          scene.palette,
          'A selected-room change must not recolor the whole house.',
        );
        assert.deepEqual(result.design?.connections, scene.design?.connections);
        assert.deepEqual(result.fireplace, scene.fireplace);
        assert.deepEqual(result.stairs, scene.stairs);
      },
    };
  }

  if (name === 'attach') {
    const scene: Scene = {
      ...structuredClone(emptyScene),
      slope: 0,
      rooms: [
        makeRoom({
          id: 'main',
          name: 'Main living room',
          kind: 'living',
          x: 0,
          z: 0,
          width: 12,
          depth: 8,
          east: 'solid',
          west: 'solid',
        }),
        makeRoom({
          id: 'west-bed',
          name: 'West bedroom',
          kind: 'bedroom',
          x: -12,
          z: 0,
          width: 6,
          depth: 6,
        }),
        makeRoom({
          id: 'west-bath',
          name: 'West bathroom',
          kind: 'bathroom',
          x: -12,
          z: -4.5,
          width: 6,
          depth: 3,
        }),
        makeRoom({
          id: 'east-bed',
          name: 'East bedroom',
          kind: 'bedroom',
          x: 12,
          z: 0,
          width: 6,
          depth: 6,
        }),
        makeRoom({
          id: 'east-bath',
          name: 'East bathroom',
          kind: 'bathroom',
          x: 12,
          z: -4.5,
          width: 6,
          depth: 3,
        }),
        makeRoom({ id: 'studio', name: 'Separate garden studio', kind: 'other', x: 0, z: 20 }),
      ],
      design: {
        groups: [
          {
            id: 'west-wing',
            name: 'West bedroom and bathroom',
            roomIds: ['west-bed', 'west-bath'],
          },
          {
            id: 'east-wing',
            name: 'East bedroom and bathroom',
            roomIds: ['east-bed', 'east-bath'],
          },
        ],
        connections: [],
        stairLinks: [],
        requirements: [],
      },
    };
    return {
      scene,
      prompt:
        'Make sure the two bedrooms are attached directly to the main living room with indoor doors. Move each bedroom and its bathroom together, preserving their relative arrangement and all room dimensions. Also connect each bathroom to its own bedroom. Keep the main living room in place and leave the separate garden studio unchanged. Do not add or remove rooms. Keep the west and east wings on their respective sides.',
      verify(result) {
        sameRoomIds(scene, result);
        assert.deepEqual(geometry(room(result, 'main')), geometry(room(scene, 'main')));
        assert.deepEqual(room(result, 'studio'), room(scene, 'studio'));
        for (const side of ['west', 'east']) {
          const bed = room(result, `${side}-bed`),
            bath = room(result, `${side}-bath`);
          connected(result, 'main', bed.id);
          connected(result, bed.id, bath.id);
          assert.equal(bath.x - bed.x, 0);
          assert.equal(bath.z - bed.z, -4.5);
          assert.equal(sharedBoundary(room(result, 'main'), bed)?.sideA, side);
          for (const member of [bed, bath]) {
            const original = room(scene, member.id);
            assert.deepEqual(
              [member.width, member.depth, member.height, member.elevation],
              [original.width, original.depth, original.height, original.elevation],
            );
          }
        }
        assert.deepEqual(result.fireplace, scene.fireplace);
        assert.deepEqual(result.stairs, scene.stairs);
      },
    };
  }

  const scene = prepare(
    {
      ...structuredClone(emptyScene),
      slope: 0,
      rooms: [
        makeRoom({
          id: 'kitchen',
          name: 'Kitchen',
          kind: 'kitchen',
          x: 0,
          z: 0,
          width: 6,
          depth: 6,
          east: 'solid',
        }),
        makeRoom({ id: 'bed', name: 'Bedroom', kind: 'bedroom', x: 6, z: 0, width: 6, depth: 6 }),
        makeRoom({
          id: 'bath',
          name: 'Bathroom',
          kind: 'bathroom',
          x: 6,
          z: -4.5,
          width: 6,
          depth: 3,
        }),
        makeRoom({ id: 'studio', name: 'Separate garden studio', x: -20, z: 20 }),
      ],
      fireplace: { x: 6, z: 0, elevation: 0, height: 4 },
    },
    [
      { type: 'connect_rooms', roomAId: 'kitchen', roomBId: 'bed' },
      { type: 'connect_rooms', roomAId: 'bed', roomBId: 'bath' },
      {
        type: 'define_group',
        group: { id: 'suite', name: 'Bedroom suite', roomIds: ['bed', 'bath'] },
      },
    ],
  );
  return {
    scene,
    context: { selectedRoomId: 'kitchen', view: 'plan' },
    prompt:
      'Make this kitchen exactly 8 meters wide by extending its east edge, keeping its west edge fixed. Keep its depth and height. Move the connected bedroom and bathroom together as needed so their indoor doors remain connected; move the fireplace with its bedroom. Do not resize the suite or change the separate garden studio.',
    verify(result) {
      sameRoomIds(scene, result);
      const kitchen = room(result, 'kitchen'),
        bed = room(result, 'bed'),
        bath = room(result, 'bath');
      assert.equal(kitchen.width, 8);
      assert.equal(bounds(kitchen).west, bounds(room(scene, 'kitchen')).west);
      assert.equal(kitchen.depth, 6);
      assert.equal(kitchen.height, room(scene, 'kitchen').height);
      assert.deepEqual(geometry(bed), { ...geometry(room(scene, 'bed')), x: 8 });
      assert.deepEqual(geometry(bath), { ...geometry(room(scene, 'bath')), x: 8 });
      connected(result, kitchen.id, bed.id);
      connected(result, bed.id, bath.id);
      assert.deepEqual(result.fireplace, { ...scene.fireplace!, x: 8 });
      assert.deepEqual(room(result, 'studio'), room(scene, 'studio'));
    },
  };
}

const args = process.argv.slice(2);
if (!args.includes('--live')) {
  console.error(
    'Live verification uses API credits. Run npm run verify:design -- --live --case selected|attach|empty|resize|all. Default: selected.',
  );
  process.exit(1);
}
const requested =
  args.find((arg) => arg.startsWith('--case='))?.slice(7) ||
  (args.includes('--case') ? args[args.indexOf('--case') + 1] : 'selected');
if (!requested || (requested !== 'all' && !caseNames.includes(requested as CaseName)))
  throw new Error('Choose --case selected, attach, empty, resize, or all.');
const chosen = requested === 'all' ? caseNames : [requested as CaseName];
const base = new URL(process.env.TERRAIN_BASE_URL || 'http://localhost:5173');
if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))
  throw new Error('Verification must use the local Terrain server.');
async function request(route: string, body?: unknown) {
  const response = await fetch(new URL(`/api/${route}`, base), {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(310000),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(`${route}: ${error.error || response.status}`);
  }
  return response;
}

let savedBefore: string | undefined;
try {
  const status = await (await request('status')).json();
  assert.ok(status.gatewayConnected, 'Configure a Vercel AI Gateway key before live verification.');
  assert.ok(
    status.dailyLimit - status.usage.requests >= chosen.length * AGENT_LIMITS.modelCalls,
    `Reserve ${chosen.length * AGENT_LIMITS.modelCalls} cloud request slots for the bounded model rounds.`,
  );
  savedBefore = await (await request('project')).text();
  for (const name of chosen) {
    const fixture = makeCase(name);
    const start = performance.now();
    const result: HarnessResult = await (
      await request('agent', {
        runId: crypto.randomUUID(),
        previewOnly: true,
        scene: fixture.scene,
        context: fixture.context,
        messages: [{ id: `evaluation-${name}`, role: 'user', text: fixture.prompt }],
      })
    ).json();
    const design = agentResponseSchema.parse(result);
    assert.ok(design.scene, `${name}: the request requires a design change, not a clarification.`);
    assert.equal(
      result.draftId,
      undefined,
      'Preview evaluations must not produce committable drafts.',
    );
    assert.deepEqual(
      validateDesignChange(fixture.scene, design.scene).filter(
        (issue) => issue.severity === 'error',
      ),
      [],
      `${name}: the design must satisfy geometry and circulation checks.`,
    );
    fixture.verify(design.scene);
    assert.ok(result.usage.calls >= 1 && result.usage.calls <= AGENT_LIMITS.modelCalls);
    console.log(
      JSON.stringify({
        check: name,
        result: 'passed',
        model: status.model,
        modelCalls: result.usage.calls,
        reportedModelCost: result.usage.cost,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        repairs: result.events.filter((event) => event.stage === 'repairing').length,
        needsConfirmation: result.needsConfirmation,
        seconds: +((performance.now() - start) / 1000).toFixed(2),
      }),
    );
  }
  const after = await (await request('status')).json();
  assert.equal(
    await (await request('project')).text(),
    savedBefore,
    'The saved project changed during verification.',
  );
  console.log(
    JSON.stringify({
      result: 'passed',
      cases: chosen,
      cloudRequests: after.usage.requests - status.usage.requests,
      savedProjectUnchanged: true,
    }),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Design verification failed.');
  process.exitCode = 1;
} finally {
  if (savedBefore !== undefined) {
    try {
      assert.equal(
        await (await request('project')).text(),
        savedBefore,
        'The saved project changed during verification; another session may be active.',
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'Could not verify the saved project.');
      process.exitCode = 1;
    }
  }
}

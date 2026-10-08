import assert from 'node:assert/strict';
import { z } from 'zod';
import { canonical } from '../shared/draft.ts';
import { emptyScene, makeRoom, type Scene } from '../shared/model.ts';
import { effectiveSurfacePalettes } from '../shared/design.ts';
import type { AgentContext } from '../shared/harness.ts';

/** Reservations bound requests; provider-reported charges are settled afterward. */
export class VerificationBudget {
  readonly entries: { case: string; cost: number | null; settled: boolean }[] = [];
  constructor(
    readonly limit = 5,
    readonly reservation = 0.5,
    readonly maxCalls = 10,
  ) {
    assert(limit > 0 && limit <= 5 && reservation > 0 && maxCalls > 0 && maxCalls <= 10);
  }
  importLedger(input: unknown) {
    assert.equal(this.entries.length, 0, 'Import a ledger before making calls.');
    const ledger = z
      .object({
        limit: z.number().positive().max(5),
        reservation: z.number().positive(),
        maxCalls: z.number().int().positive().max(10),
        reportedCost: z.number().nonnegative(),
        calls: z
          .array(
            z
              .object({
                case: z.enum(['floor', 'shared-wall']),
                cost: z.number().finite().nonnegative(),
                settled: z.literal(true),
              })
              .strict(),
          )
          .max(10),
      })
      .passthrough()
      .parse(input);
    assert.equal(ledger.limit, this.limit);
    assert.equal(ledger.reservation, this.reservation);
    assert.equal(ledger.maxCalls, this.maxCalls);
    assert(
      Math.abs(ledger.reportedCost - ledger.calls.reduce((sum, item) => sum + item.cost, 0)) < 1e-8,
      'Ledger total does not match settled charges.',
    );
    this.entries.push(...structuredClone(ledger.calls));
  }
  reserve(caseName: string) {
    assert(
      this.entries.every((item) => item.settled && item.cost !== null),
      'Previous charge unknown; no further calls allowed.',
    );
    assert(this.entries.length < this.maxCalls, 'Aggregate model-call limit reached.');
    assert(this.total + this.reservation <= this.limit, 'Reported-cost budget exhausted.');
    this.entries.push({ case: caseName, cost: null, settled: false });
  }
  settle(cost: number | null) {
    const entry = this.entries.at(-1)!;
    assert(entry && !entry.settled, 'No outstanding reservation.');
    assert(cost === null || (Number.isFinite(cost) && cost >= 0));
    entry.cost = cost;
    entry.settled = true;
  }
  get total() {
    return this.entries.reduce((total, item) => total + (item.cost || 0), 0);
  }
}

export function capabilityCases(): {
  name: string;
  scene: Scene;
  prompt: string;
  context: AgentContext;
  verify: (scene: Scene) => void;
}[] {
  const scene: Scene = {
    ...structuredClone(emptyScene),
    design: { connections: [], groups: [], requirements: [], stairLinks: [] },
    rooms: [
      makeRoom({
        id: 'kitchen',
        name: 'Kitchen',
        kind: 'kitchen',
        width: 4,
        depth: 5,
        x: -2,
        east: 'open',
        furniture: [],
        surfacePalettes: { north: 'charcoal', roof: 'cedar' },
      }),
      makeRoom({
        id: 'dining',
        name: 'Dining',
        kind: 'other',
        width: 4,
        depth: 5,
        x: 2,
        west: 'open',
        furniture: [],
        surfacePalettes: { floor: 'chalk' },
      }),
      makeRoom({
        id: 'study',
        name: 'Study',
        kind: 'living',
        width: 3,
        depth: 3,
        x: 10,
        furniture: [],
      }),
    ],
  };
  const sharedScene = structuredClone(scene);
  sharedScene.rooms[0].east = 'solid';
  sharedScene.rooms[1].west = 'solid';
  sharedScene.rooms[1].east = 'solid';
  sharedScene.design!.connections = [
    {
      id: 'kitchen-dining',
      roomAId: 'kitchen',
      roomBId: 'dining',
      sideA: 'east',
      kind: 'open',
      center: 0,
      width: 1.3,
      height: 3,
    },
  ];
  sharedScene.rooms[1].surfacePalettes = { roof: 'cedar', north: 'charcoal' };
  return [
    {
      name: 'floor',
      scene: structuredClone(scene),
      prompt:
        'Change only the kitchen floor to chalk. Keep its charcoal north wall and cedar roof, every other surface, furniture, room geometry and the rest of the house exactly unchanged. Review the final floor in a live interior image before finishing and include typed material and preservation assertions.',
      context: {
        selection: { roomId: 'kitchen', surface: 'floor' },
        editScope: { roomId: 'kitchen', surface: 'floor' },
        preservationChecks: [
          { kind: 'unchanged_room', roomId: 'dining' },
          { kind: 'unchanged_surface', roomId: 'kitchen', surface: 'north' },
          { kind: 'unchanged_surface', roomId: 'kitchen', surface: 'roof' },
        ],
      },
      verify(result) {
        assert.equal(
          effectiveSurfacePalettes(
            result,
            result.rooms.find((room) => room.id === 'kitchen')!,
          ).floor,
          'chalk',
        );
        const normalized = structuredClone(result);
        delete normalized.rooms[0].surfacePalettes?.floor;
        assert.equal(canonical(normalized), canonical(scene), 'Only the kitchen floor may change.');
      },
    },
    {
      name: 'shared-wall',
      scene: structuredClone(sharedScene),
      prompt:
        'Give the kitchen one metre from the adjoining dining room by moving their shared wall east one metre. Keep the exterior footprint fixed, both room identities, existing open connection, materials and unrelated study unchanged. Kitchen should end width 5, x -1.5; dining width 3, x 2.5; depths remain 5. Review the result in a live cutaway image before finishing and include exact geometry checks.',
      context: {
        selection: { surface: 'room', roomId: 'kitchen' },
        preservationChecks: [{ kind: 'unchanged_room', roomId: 'study' }],
      },
      verify(result) {
        const kitchen = result.rooms.find((room) => room.id === 'kitchen')!;
        const dining = result.rooms.find((room) => room.id === 'dining')!;
        assert.deepEqual(
          [kitchen.width, kitchen.x, kitchen.depth, dining.width, dining.x, dining.depth],
          [5, -1.5, 5, 3, 2.5, 5],
        );
        const expected = structuredClone(sharedScene);
        Object.assign(expected.rooms[0], { width: 5, x: -1.5, east: 'open' });
        Object.assign(expected.rooms[1], { width: 3, x: 2.5, west: 'open' });
        assert.equal(
          canonical(result),
          canonical(expected),
          'Shared-wall edits must preserve all unrelated data and outer extents.',
        );
      },
    },
  ];
}

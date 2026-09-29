import { emptyScene, makeRoom as makeBaseRoom, type Scene } from './model.ts';
import { executeCommands, validateDesignChange, type DesignCommand } from './design.ts';

const makeRoom = (overrides: Partial<Scene['rooms'][number]>) =>
  makeBaseRoom({
    north: 'solid',
    south: 'solid',
    east: 'solid',
    west: 'solid',
    ...overrides,
  });

/** A coherent interpretation of the original hillside brief. This is a local
 * example, not a replacement for any saved project or a construction plan.
 */
export function hillsideHouse(): Scene {
  const base: Scene = {
    ...structuredClone(emptyScene),
    name: 'Courtyard hillside house',
    slope: 0.16,
    palette: 'limestone',
    roof: 'flat',
    rooms: [
      makeRoom({
        id: 'living',
        name: 'Double-height living room',
        kind: 'living',
        x: 0,
        z: 2.5,
        width: 12,
        depth: 7,
        height: 6.2,
        north: 'open',
        south: 'glass',
      }),
      makeRoom({
        id: 'kitchen',
        name: 'Overlooking kitchen platform',
        kind: 'kitchen',
        x: 0,
        z: -3.5,
        elevation: 3,
        width: 12,
        depth: 5,
        height: 3.2,
        south: 'open',
        north: 'glass',
      }),
      makeRoom({
        id: 'studio',
        name: 'Garden studio beneath the kitchen',
        kind: 'other',
        x: 0,
        z: -3.5,
        width: 12,
        depth: 5,
        height: 3,
        south: 'open',
        north: 'glass',
      }),
      ...([-1, 1] as const).flatMap((sign) => {
        const side = sign < 0 ? 'west' : 'east';
        return [
          makeRoom({
            id: `${side}-suite`,
            name: `${side === 'west' ? 'West' : 'East'} upper bedroom`,
            kind: 'bedroom',
            x: sign * 8.5,
            z: -3.5,
            elevation: 3,
            width: 5,
            depth: 5,
            height: 3.2,
          }),
          makeRoom({
            id: `${side}-bath`,
            name: `${side === 'west' ? 'West' : 'East'} upper bathroom`,
            kind: 'bathroom',
            x: sign * 8.5,
            z: -7,
            elevation: 3,
            width: 5,
            depth: 2,
            height: 3.2,
          }),
          makeRoom({
            id: `${side}-guest`,
            name: `${side === 'west' ? 'West' : 'East'} garden bedroom`,
            kind: 'bedroom',
            x: sign * 8.5,
            z: -3.5,
            width: 5,
            depth: 5,
            height: 3,
          }),
          makeRoom({
            id: `${side}-guest-bath`,
            name: `${side === 'west' ? 'West' : 'East'} garden bathroom`,
            kind: 'bathroom',
            x: sign * 8.5,
            z: -7,
            width: 5,
            depth: 2,
            height: 3,
          }),
          makeRoom({
            id: `${side}-courtyard`,
            name: `${side === 'west' ? 'West' : 'East'} sunken courtyard`,
            kind: 'courtyard',
            x: sign * 8.5,
            z: 1.5,
            width: 5,
            depth: 5,
            height: 3,
            north: 'open',
            south: 'open',
            east: 'open',
            west: 'open',
          }),
        ];
      }),
    ],
    stairs: [],
    fireplace: { x: 0, z: 1.1, elevation: 0, height: 8.4 },
  };
  const operations: DesignCommand[] = [];
  for (const [side, sign] of [
    ['west', -1],
    ['east', 1],
  ] as const) {
    operations.push(
      {
        type: 'define_group',
        group: {
          id: `${side}-wing`,
          name: `${side === 'west' ? 'West' : 'East'} bedroom wing`,
          roomIds: [`${side}-suite`, `${side}-bath`, `${side}-guest`, `${side}-guest-bath`],
        },
      },
      {
        type: 'connect_rooms',
        roomAId: 'kitchen',
        roomBId: `${side}-suite`,
        kind: 'door',
        width: 1.3,
        height: 2.4,
      },
      {
        type: 'connect_rooms',
        roomAId: `${side}-suite`,
        roomBId: `${side}-bath`,
        kind: 'door',
        width: 1.1,
        height: 2.4,
      },
      {
        type: 'connect_rooms',
        roomAId: `${side}-guest`,
        roomBId: `${side}-guest-bath`,
        kind: 'door',
        width: 1.1,
        height: 2.4,
      },
      {
        type: 'connect_rooms',
        roomAId: `${side}-guest`,
        roomBId: `${side}-courtyard`,
        kind: 'door',
        width: 1.1,
        height: 2.4,
        center: sign * (8.5 + 1.3),
      },
      {
        type: 'connect_rooms',
        roomAId: 'living',
        roomBId: `${side}-courtyard`,
        kind: 'door',
        width: 2.4,
        height: 2.6,
        center: 2,
      },
      {
        type: 'set_wall_openings',
        roomId: `${side}-guest`,
        side: 'south',
        openings: [
          {
            id: `${side}-garden-window`,
            kind: 'window',
            offset: -sign * 1.1,
            width: 1.7,
            height: 1.6,
            sill: 0.7,
          },
        ],
      },
      {
        type: 'set_wall_openings',
        roomId: `${side}-suite`,
        side,
        openings: [
          {
            id: `${side}-bedroom-window`,
            kind: 'window',
            offset: 0,
            width: 2.8,
            height: 1.9,
            sill: 0.6,
          },
        ],
      },
      {
        type: 'set_wall_openings',
        roomId: `${side}-bath`,
        side: 'north',
        openings: [
          {
            id: `${side}-bath-window`,
            kind: 'window',
            offset: 0,
            width: 1.7,
            height: 0.8,
            sill: 1.5,
          },
        ],
      },
      {
        type: 'add_stairs',
        stairs: [
          {
            id: `${side}-living-stair`,
            x: sign * 4.5,
            z: 1.05,
            elevation: 0,
            rise: 3,
            width: 1.3,
            run: 4.5,
            rotation: 180,
          },
          {
            id: `${side}-wing-stair`,
            x: sign * 8.5,
            z: -3.5,
            elevation: 0,
            rise: 3,
            width: 1.1,
            run: 3,
            rotation: 0,
          },
        ],
      },
      {
        type: 'link_stairs',
        stairId: `${side}-living-stair`,
        lowerRoomId: 'living',
        upperRoomId: 'kitchen',
      },
      {
        type: 'link_stairs',
        stairId: `${side}-wing-stair`,
        lowerRoomId: `${side}-guest`,
        upperRoomId: `${side}-suite`,
      },
    );
  }
  operations.push(
    {
      type: 'set_requirement',
      requirement: {
        id: 'indoor-access',
        kind: 'connectivity',
        source: 'confirmed',
        description: 'Every bedroom and bathroom has an indoor route to the main living space.',
        roomIds: base.rooms
          .filter((r) => ['bedroom', 'bathroom'].includes(r.kind))
          .map((r) => r.id),
        targetRoomId: 'living',
        indoorOnly: true,
      },
    },
    {
      type: 'set_requirement',
      requirement: {
        id: 'overlooking-kitchen',
        kind: 'overlook',
        source: 'confirmed',
        description:
          'The upper kitchen platform overlooks the double-height living room and central fireplace.',
        upperRoomId: 'kitchen',
        lowerRoomId: 'living',
      },
    },
    {
      type: 'set_requirement',
      requirement: {
        id: 'mirrored-wings',
        kind: 'symmetry',
        source: 'confirmed',
        description: 'The two bedroom wings and courtyard layouts mirror each other.',
        axis: 'x',
        center: 0,
        pairs: ['suite', 'bath', 'guest', 'guest-bath', 'courtyard'].map((suffix) => ({
          roomAId: `west-${suffix}`,
          roomBId: `east-${suffix}`,
        })),
      },
    },
  );
  const result = executeCommands(base, operations);
  const errors = [...result.issues, ...validateDesignChange(emptyScene, result.scene)].filter(
    (issue) => issue.severity === 'error',
  );
  if (!result.applied || errors.length)
    throw new Error(
      `The hillside example is invalid: ${errors.map((issue) => issue.message).join(' ')}`,
    );
  return result.scene;
}

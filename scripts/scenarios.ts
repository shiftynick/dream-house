import { executeCommands, validateDesign, type DesignCommand } from '../shared/design.ts';
import { emptyScene, makeRoom, type Scene } from '../shared/model.ts';
import { hillsideHouse } from '../shared/examples.ts';

/** Deterministic inputs for local browser checks and benchmarks. These are test
 * scenarios, not a substitute for evaluating the real agent's interpretation. */
export function cabinOperations(): DesignCommand[] {
  const rearEave = 3.1 + 6 * Math.tan((12 * Math.PI) / 180);
  return [
    { type: 'update_site', name: 'Mountain cabin', slope: 0.16 },
    { type: 'set_material', palette: 'cedar' },
    { type: 'set_roof', style: 'single-pitch', pitch: 12, direction: 'north' },
    {
      type: 'add_rooms',
      rooms: [
        makeRoom({
          id: 'living',
          name: 'Living and kitchen',
          kind: 'living',
          width: 8,
          depth: 6,
          height: 3.1,
          north: 'solid',
          south: 'solid',
          east: 'solid',
          west: 'solid',
        }),
        makeRoom({
          id: 'bedroom',
          name: 'Bedroom',
          kind: 'bedroom',
          x: -2,
          z: -5,
          width: 4,
          depth: 4,
          height: rearEave,
          north: 'solid',
          south: 'solid',
          east: 'solid',
          west: 'solid',
        }),
        makeRoom({
          id: 'bathroom',
          name: 'Bathroom',
          kind: 'bathroom',
          x: 2,
          z: -5,
          width: 4,
          depth: 4,
          height: rearEave,
          north: 'solid',
          south: 'solid',
          east: 'solid',
          west: 'solid',
        }),
        makeRoom({
          id: 'deck',
          name: 'South deck',
          kind: 'terrace',
          z: 4.5,
          width: 8,
          depth: 3,
          palette: 'cedar',
        }),
      ],
    },
    {
      type: 'connect_rooms',
      roomAId: 'living',
      roomBId: 'bedroom',
      kind: 'door',
      width: 1,
      height: 2.2,
    },
    {
      type: 'connect_rooms',
      roomAId: 'living',
      roomBId: 'bathroom',
      kind: 'door',
      width: 1,
      height: 2.2,
    },
    {
      type: 'connect_rooms',
      roomAId: 'living',
      roomBId: 'deck',
      kind: 'door',
      center: 2.9,
      width: 1.2,
      height: 2.4,
    },
    {
      type: 'set_wall_openings',
      roomId: 'living',
      side: 'south',
      openings: [
        { id: 'south-window-a', kind: 'window', offset: -2.2, width: 2.8, height: 2.3, sill: 0.4 },
        { id: 'south-window-b', kind: 'window', offset: 0.8, width: 2.4, height: 2.3, sill: 0.4 },
      ],
    },
    {
      type: 'set_wall_openings',
      roomId: 'living',
      side: 'east',
      openings: [
        { id: 'east-window', kind: 'window', offset: 0, width: 2.8, height: 1.8, sill: 0.8 },
      ],
    },
    {
      type: 'set_wall_openings',
      roomId: 'bedroom',
      side: 'west',
      openings: [
        { id: 'bedroom-window', kind: 'window', offset: 0, width: 1.8, height: 1.5, sill: 0.8 },
      ],
    },
  ];
}

export function cabinScene(): Scene {
  const result = executeCommands(emptyScene, cabinOperations());
  const errors = result.issues.filter((issue) => issue.severity === 'error');
  if (!result.applied || errors.length) throw new Error(JSON.stringify(errors));
  return result.scene;
}

export function stressScene(): Scene {
  const scene: Scene = {
    ...structuredClone(emptyScene),
    name: '24-room stress scene',
    roof: 'single-pitch',
    roofPitch: 8,
    roofDirection: 'north',
    slope: 0.22,
  };
  const operations: DesignCommand[] = [];
  for (let z = 0; z < 4; z++)
    for (let x = 0; x < 6; x++) {
      const id = `room-${x}-${z}`;
      scene.rooms.push(
        makeRoom({
          id,
          name: `Room ${x + 1},${z + 1}`,
          kind: (['living', 'kitchen', 'bedroom', 'bathroom'] as const)[(x + z) % 4],
          x: (x - 2.5) * 5,
          z: (z - 1.5) * 5,
          width: 5,
          depth: 5,
          height: 3.2,
        }),
      );
      if (x)
        operations.push({
          type: 'connect_rooms',
          roomAId: `room-${x - 1}-${z}`,
          roomBId: id,
          kind: 'door',
          width: 1.2,
          height: 2.3,
        });
      if (z)
        operations.push({
          type: 'connect_rooms',
          roomAId: `room-${x}-${z - 1}`,
          roomBId: id,
          kind: 'door',
          width: 1.2,
          height: 2.3,
        });
      if (z === 3 || z === 0)
        operations.push({
          type: 'set_wall_openings',
          roomId: id,
          side: z === 0 ? 'north' : 'south',
          openings: [
            { id: `${id}-window`, kind: 'window', offset: 0, width: 3.6, height: 2, sill: 0.7 },
          ],
        });
    }
  const result = executeCommands(scene, operations);
  if (!result.applied || validateDesign(result.scene).some((issue) => issue.severity === 'error'))
    throw new Error(JSON.stringify(result.issues));
  return result.scene;
}

export const scenarios = { cabin: cabinScene, hillside: hillsideHouse, stress: stressScene };

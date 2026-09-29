import type { Furniture, Room, Scene } from './model.ts';
import { furnitureBounds, materializeFurniture } from './furniture.ts';
import { inspectRoomFurniture } from './spatial.ts';

export const furnitureBlockingCodes = new Set([
  'furniture_outside_room',
  'furniture_overlap',
  'door_approach_blocked',
  'door_swing_obstructed',
  'furniture_stair_blocked',
]);

function score(scene: Scene, room: Room) {
  const clearance = inspectRoomFurniture(scene, room).reduce((sum, problem) => {
    const weight =
      problem.code === 'furniture_outside_room'
        ? 10000
        : furnitureBlockingCodes.has(problem.code)
          ? 1000
          : 10;
    const detail = problem.details;
    const gap = typeof detail?.measuredGap === 'number' ? detail.measuredGap : 0;
    return sum + weight + (gap < 0 ? -gap * 100 : 0);
  }, 0);
  const items = room.furniture || [],
    sofa = items.find((item) => item.kind === 'sofa'),
    table = items.find((item) => item.kind === 'coffee-table');
  let composition = 0;
  if (sofa && table) {
    const a = furnitureBounds(sofa),
      b = furnitureBounds(table);
    const centerX =
      (Math.min(sofa.x - a.width / 2, table.x - b.width / 2) +
        Math.max(sofa.x + a.width / 2, table.x + b.width / 2)) /
      2;
    const centerZ =
      (Math.min(sofa.z - a.depth / 2, table.z - b.depth / 2) +
        Math.max(sofa.z + a.depth / 2, table.z + b.depth / 2)) /
      2;
    composition += Math.hypot(centerX / room.width, centerZ / room.depth) * 4;
    const yaw = (sofa.rotation * Math.PI) / 180,
      dx = table.x - sofa.x,
      dz = table.z - sofa.z;
    const distance = sofa.depth / 2 + table.depth / 2 + 0.6;
    composition += Math.hypot(dx - Math.sin(yaw) * distance, dz - Math.cos(yaw) * distance);
  }
  return clearance + Math.min(5, composition);
}

function coordinates(half: number, size: number, current: number) {
  const low = -half + size / 2 + 0.12,
    high = half - size / 2 - 0.12;
  if (low > high) return [0];
  return [
    ...new Set(
      [current, low, high, 0, ...Array.from({ length: 7 }, (_, i) => low + ((high - low) * i) / 6)]
        .filter((v) => v >= low && v <= high)
        .map((v) => Math.round(v * 1000) / 1000),
    ),
  ];
}

/** Bounded coordinate search. Keeps inventory, dimensions, IDs and architecture;
 * reports remaining conflicts through the normal inspection, never deletes to fit. */
export function arrangeFurniture(scene: Scene, room: Room) {
  const items = materializeFurniture(room);
  const original = structuredClone(items);
  const movable = items
    .filter((item) => item.kind !== 'rug')
    .sort((a, b) => b.width * b.depth - a.width * a.depth);
  // Translate a seating group together before individual refinement. This avoids
  // getting stuck around an already-clear but awkward corner layout.
  const seating = items.find((item) => item.kind === 'sofa'),
    table = items.find((item) => item.kind === 'coffee-table');
  if (seating && table) {
    const group = [seating, table],
      saved = group.map((item) => ({ ...item }));
    const rects = group.map((item) => ({ item, ...furnitureBounds(item) }));
    const minX = Math.min(...rects.map((r) => r.item.x - r.width / 2)),
      maxX = Math.max(...rects.map((r) => r.item.x + r.width / 2));
    const minZ = Math.min(...rects.map((r) => r.item.z - r.depth / 2)),
      maxZ = Math.max(...rects.map((r) => r.item.z + r.depth / 2));
    const cx = (minX + maxX) / 2,
      cz = (minZ + maxZ) / 2;
    let best = score(scene, room),
      dx = 0,
      dz = 0;
    for (const x of coordinates(room.width / 2, maxX - minX, cx))
      for (const z of coordinates(room.depth / 2, maxZ - minZ, cz)) {
        group.forEach((item, i) =>
          Object.assign(item, { x: saved[i].x + x - cx, z: saved[i].z + z - cz }),
        );
        const value = score(scene, room) + Math.hypot(x - cx, z - cz) * 0.001;
        if (value < best - 0.00001) {
          best = value;
          dx = x - cx;
          dz = z - cz;
        }
      }
    group.forEach((item, i) =>
      Object.assign(item, {
        x: Math.round((saved[i].x + dx) * 1000) / 1000,
        z: Math.round((saved[i].z + dz) * 1000) / 1000,
      }),
    );
  }
  for (let pass = 0; pass < 2; pass++) {
    let changed = false;
    for (const item of movable) {
      const before = { ...item };
      let best: Furniture = { ...item },
        bestScore = score(scene, room);
      for (const rotation of [before.rotation, 0, 90, 180, 270]) {
        const size = furnitureBounds({ ...item, rotation });
        for (const x of coordinates(room.width / 2, size.width, before.x))
          for (const z of coordinates(room.depth / 2, size.depth, before.z)) {
            Object.assign(item, { x, z, rotation });
            // Preserve the current layout when equally good. Small movement costs
            // keep the search deterministic and prevent arbitrary rearrangement.
            const candidate =
              score(scene, room) +
              Math.hypot(x - before.x, z - before.z) * 0.001 +
              (rotation === before.rotation ? 0 : 0.001);
            if (candidate < bestScore - 0.00001) {
              bestScore = candidate;
              best = { ...item };
            }
          }
      }
      Object.assign(item, best);
      changed ||= item.x !== before.x || item.z !== before.z || item.rotation !== before.rotation;
    }
    if (!changed) break;
  }
  // A decorative rug follows its seating group without affecting collision scores.
  const sofa = items.find((item) => item.kind === 'sofa');
  const oldSofa = original.find((item) => item.id === sofa?.id);
  if (sofa && oldSofa)
    for (const rug of items.filter((item) => item.kind === 'rug')) {
      const yaw = ((sofa.rotation - oldSofa.rotation) * Math.PI) / 180;
      const dx = rug.x - oldSofa.x,
        dz = rug.z - oldSofa.z;
      rug.x = Math.round((sofa.x + Math.cos(yaw) * dx + Math.sin(yaw) * dz) * 1000) / 1000;
      rug.z = Math.round((sofa.z - Math.sin(yaw) * dx + Math.cos(yaw) * dz) * 1000) / 1000;
      rug.rotation = (((rug.rotation + sofa.rotation - oldSofa.rotation) % 360) + 360) % 360;
    }
  return inspectRoomFurniture(scene, room);
}

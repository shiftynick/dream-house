import type { Furniture, FurnitureKind, Room, Side } from './model.ts';

export const furnitureCatalog: Record<
  FurnitureKind,
  {
    name: string;
    width: number;
    depth: number;
    height: number;
  }
> = {
  sofa: { name: 'Sofa', width: 3.3, depth: 1.185, height: 0.955 },
  armchair: { name: 'Armchair', width: 0.95, depth: 0.9, height: 0.9 },
  'coffee-table': { name: 'Coffee table', width: 1.7, depth: 0.8, height: 0.455 },
  'dining-table': { name: 'Dining table', width: 1.8, depth: 0.9, height: 0.76 },
  chair: { name: 'Chair', width: 0.5, depth: 0.55, height: 0.85 },
  bed: { name: 'Bed', width: 2.25, depth: 2.325, height: 1.5 },
  nightstand: { name: 'Nightstand', width: 0.5, depth: 0.45, height: 0.55 },
  wardrobe: { name: 'Wardrobe', width: 1.8, depth: 0.6, height: 2.1 },
  counter: { name: 'Kitchen counter', width: 3, depth: 1.1, height: 0.975 },
  island: { name: 'Kitchen island', width: 2.4, depth: 1.35, height: 1.085 },
  bath: { name: 'Bath', width: 1.8, depth: 0.8, height: 0.82 },
  vanity: { name: 'Vanity', width: 1.2, depth: 0.55, height: 0.9 },
  toilet: { name: 'Toilet', width: 0.45, depth: 0.7, height: 0.8 },
  rug: { name: 'Rug', width: 3, depth: 2, height: 0.025 },
};

export function makeFurniture(
  kind: FurnitureKind,
  id: string,
  patch: Partial<Furniture> = {},
): Furniture {
  return { id, kind, ...furnitureCatalog[kind], x: 0, z: 0, rotation: 0, ...patch };
}

/** Stable legacy IDs and positions. Reading a house never rewrites its document. */
export function roomFurniture(room: Room): Furniture[] {
  if (room.furniture !== undefined) return room.furniture;
  if (room.kind === 'living')
    return [
      makeFurniture('sofa', 'sofa', { x: -room.width * 0.22, z: room.depth * 0.13 - 0.0175 }),
      makeFurniture('coffee-table', 'table', { x: -room.width * 0.22, z: room.depth * 0.13 + 1.6 }),
      makeFurniture('rug', 'rug', {
        x: -room.width * 0.22,
        z: room.depth * 0.13 + 0.6,
        width: 4.8,
        depth: 3.9,
      }),
    ];
  if (room.kind === 'kitchen')
    return [
      makeFurniture('counter', 'counter', { z: -room.depth / 2 + 0.6, width: room.width - 1.1 }),
      makeFurniture('island', 'island', { width: Math.min(4, room.width - 0.8) }),
    ];
  if (room.kind === 'bedroom')
    return [makeFurniture('bed', 'bed', { z: -room.depth * 0.1 - 0.0125 })];
  if (room.kind === 'bathroom') return [makeFurniture('bath', 'bath')];
  return [];
}

export function furnitureBounds(item: Pick<Furniture, 'width' | 'depth' | 'rotation'>) {
  const angle = (item.rotation * Math.PI) / 180,
    c = Math.abs(Math.cos(angle)),
    s = Math.abs(Math.sin(angle));
  return { width: c * item.width + s * item.depth, depth: s * item.width + c * item.depth };
}

/** Cardinal clearance sides use the same yaw transform as the mesh and SVG. */
export function furnitureClearance(item: Furniture): { clearance: number; clearanceSides: Side[] } {
  if (item.kind === 'rug') return { clearance: 0, clearanceSides: [] };
  const sides: Side[] = ['north', 'east', 'south', 'west'];
  const backAgainstWall = ['sofa', 'armchair', 'chair', 'bed', 'wardrobe', 'vanity', 'toilet'];
  const usable: Side[] =
    item.kind === 'counter'
      ? ['south']
      : backAgainstWall.includes(item.kind)
        ? ['east', 'south', 'west']
        : sides;
  const quarter = Math.round(item.rotation / 90);
  return {
    clearance: ['counter', 'island'].includes(item.kind) ? 0.9 : 0.6,
    clearanceSides:
      Math.abs(item.rotation / 90 - quarter) > 0.00001
        ? sides
        : usable.map((s) => sides[(((sides.indexOf(s) - quarter) % 4) + 4) % 4]),
  };
}

export function materializeFurniture(room: Room): Furniture[] {
  return (room.furniture ??= structuredClone(roomFurniture(room)));
}

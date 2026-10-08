import type { Room, Scene, Side } from './model.ts';

export const DEFAULT_ROOF_PITCH = 20;
export const DEFAULT_ROOF_DIRECTION: Side = 'north';
export const FLOOR_SLAB_THICKNESS = 0.22;
/** The floor's finished surface is at room elevation; outdoor spaces have no
 * enclosing walls or ceiling, regardless of their dormant wall flags. */
export function floorSlabBounds(room: Room) {
  return { bottom: room.elevation - FLOOR_SLAB_THICKNESS, top: room.elevation };
}
export type EffectiveRoof = { style: Scene['roof']; pitch: number; direction: Side };

/** Room height is the minimum eave above its floor, never the ridge height.
 * Unconfigured version-1 gables retain their original rise and ridge orientation.
 */
export function effectiveRoof(scene: Scene, room: Room): EffectiveRoof {
  const style = room.roof?.style ?? scene.roof;
  const legacyGable =
    !room.roof &&
    style === 'pitched' &&
    scene.roofPitch === undefined &&
    scene.roofDirection === undefined;
  return {
    style,
    pitch:
      room.roof?.pitch ??
      scene.roofPitch ??
      (legacyGable
        ? (Math.atan(Math.min(2.5, room.width * 0.22) / (room.width / 2)) * 180) / Math.PI
        : DEFAULT_ROOF_PITCH),
    direction:
      room.roof?.direction ??
      scene.roofDirection ??
      (legacyGable ? 'east' : DEFAULT_ROOF_DIRECTION),
  };
}

export function roofRise(scene: Scene, room: Room) {
  const roof = effectiveRoof(scene, room);
  if (roof.style === 'flat') return 0;
  const span = roof.direction === 'north' || roof.direction === 'south' ? room.depth : room.width;
  return (Math.tan((roof.pitch * Math.PI) / 180) * span) / (roof.style === 'pitched' ? 2 : 1);
}

/** World coordinates in, nominal world roof elevation out. Points beyond an eave
 * extend its slope so a renderer can use the same plane for an overhang.
 */
export function roofHeightAt(scene: Scene, room: Room, x: number, z: number) {
  const roof = effectiveRoof(scene, room);
  const base = room.elevation + room.height;
  if (roof.style === 'flat') return base;
  const northSouth = roof.direction === 'north' || roof.direction === 'south';
  const span = northSouth ? room.depth : room.width;
  const local = northSouth ? z - room.z : x - room.x;
  const tangent = Math.tan((roof.pitch * Math.PI) / 180);
  if (roof.style === 'pitched') return base + (span / 2 - Math.abs(local)) * tangent;
  const sign = roof.direction === 'south' || roof.direction === 'east' ? 1 : -1;
  return base + (span / 2 + sign * local) * tangent;
}

export function roofMaximumHeight(scene: Scene, room: Room) {
  return room.elevation + room.height + roofRise(scene, room);
}

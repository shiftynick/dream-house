import type { DesignCommand } from '../shared/design';
import type { Furniture, Room } from '../shared/model';
import { furnitureBounds } from '../shared/furniture';
import { round } from '../shared/geometry';

export type PlanPoint = { x: number; z: number };
/** Invert the SVG root's complete screen matrix, including responsive letterboxing. */
export function planPoint(
  clientX: number,
  clientY: number,
  matrix: { a: number; b: number; c: number; d: number; e: number; f: number },
): PlanPoint {
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12)
    throw new Error('The floor plan is not ready for editing.');
  const x = clientX - matrix.e,
    y = clientY - matrix.f;
  return {
    x: (matrix.d * x - matrix.c * y) / determinant,
    z: (-matrix.b * x + matrix.a * y) / determinant,
  };
}
const snap = (value: number, step: number) => round(Math.round(value / step) * step);
const angle = (point: PlanPoint, center: PlanPoint) =>
  Math.atan2(point.z - center.z, point.x - center.x);

export function furniturePlanError(room: Room, item: Furniture) {
  if (![item.x, item.z, item.rotation].every(Number.isFinite))
    return 'Choose finite furniture coordinates and rotation.';
  const size = furnitureBounds(item);
  if (
    Math.abs(item.x) + size.width / 2 > room.width / 2 + 0.0001 ||
    Math.abs(item.z) + size.depth / 2 > room.depth / 2 + 0.0001
  )
    return `${item.name} would extend outside ${room.name}. Drag it inside the room or choose a rotation that fits.`;
  return null;
}

/** Preview-only gesture. finish consumes it once; only the caller can commit. */
export class FurniturePlanGesture {
  private active: {
    room: Room;
    item: Furniture;
    point: PlanPoint;
    mode: 'move' | 'rotate';
    preview: Furniture;
  } | null = null;
  begin(room: Room, item: Furniture, point: PlanPoint, mode: 'move' | 'rotate') {
    this.active = { room, item: { ...item }, point, mode, preview: { ...item } };
  }
  get running() {
    return !!this.active;
  }
  update(point: PlanPoint, coarse = false) {
    const gesture = this.active;
    if (!gesture) return null;
    const { item, room } = gesture;
    if (Math.hypot(point.x - gesture.point.x, point.z - gesture.point.z) < 0.00000001) {
      gesture.preview = { ...item };
      return { ...item };
    }
    if (gesture.mode === 'move')
      gesture.preview = {
        ...item,
        x: snap(item.x + point.x - gesture.point.x, coarse ? 0.1 : 0.01),
        z: snap(item.z + point.z - gesture.point.z, coarse ? 0.1 : 0.01),
      };
    else {
      const center = { x: room.x + item.x, z: room.z + item.z };
      const rotation =
        item.rotation - ((angle(point, center) - angle(gesture.point, center)) * 180) / Math.PI;
      gesture.preview = {
        ...item,
        rotation: snap(((((rotation + 180) % 360) + 360) % 360) - 180, coarse ? 15 : 1),
      };
    }
    return { ...gesture.preview };
  }
  cancel() {
    this.active = null;
  }
  finish(): { command?: DesignCommand; error?: string } {
    const gesture = this.active;
    this.active = null;
    if (!gesture) return {};
    const { room, item, preview } = gesture;
    if (
      ['x', 'z', 'rotation'].every(
        (key) => item[key as 'x' | 'z' | 'rotation'] === preview[key as 'x' | 'z' | 'rotation'],
      )
    )
      return {};
    const error = furniturePlanError(room, preview);
    if (error) return { error };
    return {
      command: {
        type: 'update_furniture',
        roomId: room.id,
        furnitureId: item.id,
        patch: { x: preview.x, z: preview.z, rotation: preview.rotation },
      },
    };
  }
}

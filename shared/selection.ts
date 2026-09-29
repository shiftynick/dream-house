import { z } from 'zod';
import type { Palette, Room, Scene } from './model';
import { roomFurniture } from './furniture';

export const surfaceSchema = z.enum(['north', 'south', 'east', 'west', 'floor', 'roof']);
export type DesignSurface = z.infer<typeof surfaceSchema>;
export const designSelectionSchema = z
  .object({
    roomId: z.string().min(1).max(60),
    surface: z.enum(['room', 'north', 'south', 'east', 'west', 'floor', 'roof']),
    furnitureId: z.string().min(1).max(60).optional(),
  })
  .strict();
export type DesignSelection = z.infer<typeof designSelectionSchema>;

export function validSelection(scene: Scene, input: unknown): DesignSelection | null {
  const parsed = designSelectionSchema.safeParse(input);
  if (!parsed.success) return null;
  const room = scene.rooms.find((item) => item.id === parsed.data.roomId);
  if (!room) return null;
  if (
    parsed.data.furnitureId &&
    (parsed.data.surface !== 'room' ||
      !roomFurniture(room).some((item) => item.id === parsed.data.furnitureId))
  )
    return null;
  if (
    parsed.data.surface !== 'room' &&
    parsed.data.surface !== 'floor' &&
    ['courtyard', 'terrace'].includes(room.kind)
  )
    return null;
  return parsed.data;
}

export function surfacePalette(scene: Scene, room: Room, surface: DesignSurface | 'room'): Palette {
  return (
    (surface === 'room' ? undefined : room.surfacePalettes?.[surface]) ??
    room.palette ??
    scene.palette
  );
}

export function selectionLabel(scene: Scene, selection: DesignSelection | null): string {
  const valid = validSelection(scene, selection);
  if (!valid) return 'No selection';
  const room = scene.rooms.find((item) => item.id === valid.roomId)!;
  if (valid.furnitureId)
    return `${room.name} · ${roomFurniture(room).find((item) => item.id === valid.furnitureId)!.name}`;
  return valid.surface === 'room'
    ? room.name
    : `${room.name} · ${valid.surface}${['north', 'south', 'east', 'west'].includes(valid.surface) ? ' wall' : ''}`;
}

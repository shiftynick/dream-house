import { z } from 'zod';
import { canonical } from './draft.ts';
import { effectiveRoof } from './architecture.ts';
import { effectiveSurfacePalettes } from './design.ts';
import { roomFurniture } from './furniture.ts';
import { roomOpenings } from './openings.ts';
import { designSelectionSchema, type DesignSelection } from './selection.ts';
import { sideSchema, surfaceSchema, type Scene, type Room, type Side } from './model.ts';

const id = z.string().min(1).max(60);
export const preservedRoomPropertySchema = z.enum([
  'name',
  'kind',
  'geometry',
  'walls',
  'openings',
  'roof',
  'materials',
  'furniture',
]);
export const preservationAssertionSchemas = [
  z
    .object({
      kind: z.literal('unchanged_room'),
      roomId: id,
      properties: z.array(preservedRoomPropertySchema).min(1).max(8).optional(),
    })
    .strict(),
  z.object({ kind: z.literal('unchanged_surface'), roomId: id, surface: surfaceSchema }).strict(),
  z.object({ kind: z.literal('unchanged_furniture'), roomId: id, furnitureId: id }).strict(),
  z
    .object({ kind: z.literal('unchanged_opening'), roomId: id, side: sideSchema, openingId: id })
    .strict(),
  z
    .object({ kind: z.literal('unchanged_except_selection'), selection: designSelectionSchema })
    .strict(),
] as const;
export const preservationAssertionSchema = z.discriminatedUnion(
  'kind',
  preservationAssertionSchemas,
);
export type PreservationAssertion = z.infer<typeof preservationAssertionSchema>;
export type PreservationResult = { passed: boolean; actual: unknown; reason: string };
export type EditScopeReview = { selection: DesignSelection; preserved: boolean; changes: string[] };

const coordinate = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
const wallSides = ['north', 'south', 'east', 'west'] as const;
/** Compare physical apertures, including implicit legacy doors/windows. Local
 * offsets alone miss an aperture moved by shifting its owning room center. */
function worldOpenings(scene: Scene, room: Room, omittedId?: string, omittedSide?: Side) {
  return Object.fromEntries(
    wallSides
      .filter((side) => side !== omittedSide)
      .map((side) => {
        const resolved = roomOpenings(scene, room.id, side);
        const span = side === 'north' || side === 'south' ? room.width : room.depth;
        const openings = resolved.length
          ? resolved
          : room[side] === 'solid'
            ? []
            : [
                {
                  id: `legacy-${room.id}-${side}`,
                  kind: room[side] === 'glass' ? 'window' : room[side],
                  offset: 0,
                  width: room[side] === 'door' ? Math.min(1.3, span) : span,
                  height: room[side] === 'door' ? Math.min(2.4, room.height) : room.height,
                  sill: 0,
                },
              ];
        return [
          side,
          Object.fromEntries(
            openings
              .filter((opening) => opening.id !== omittedId)
              .map(({ offset, sill, ...opening }) => [
                opening.id,
                {
                  ...opening,
                  x: coordinate(
                    side === 'north' || side === 'south'
                      ? room.x + offset
                      : room.x + (side === 'west' ? -room.width / 2 : room.width / 2),
                  ),
                  z: coordinate(
                    side === 'east' || side === 'west'
                      ? room.z + offset
                      : room.z + (side === 'north' ? -room.depth / 2 : room.depth / 2),
                  ),
                  elevation: coordinate(room.elevation + sill),
                },
              ]),
          ),
        ];
      }),
  );
}
function worldFurniture(scene: Scene, room: Room) {
  return Object.fromEntries(
    roomFurniture(room).map((item) => [
      item.id,
      {
        ...item,
        x: coordinate(item.x + room.x),
        z: coordinate(item.z + room.z),
        elevation: room.elevation,
        palette: item.palette ?? room.palette ?? scene.palette,
      },
    ]),
  );
}

function roomProperties(scene: Scene, room: Room) {
  return {
    name: room.name,
    kind: room.kind,
    geometry: {
      x: room.x,
      z: room.z,
      width: room.width,
      depth: room.depth,
      height: room.height,
      elevation: room.elevation,
    },
    walls: { north: room.north, south: room.south, east: room.east, west: room.west },
    openings: worldOpenings(scene, room),
    roof: { effective: effectiveRoof(scene, room), override: room.roof },
    materials: {
      effective: effectiveSurfacePalettes(scene, room),
      palette: room.palette,
      overrides: room.surfacePalettes,
    },
    furniture: worldFurniture(scene, room),
  };
}

/** Keep every saved field except the selected logical part in the comparison.
 * Generated furniture is compared semantically so editing a legacy piece does
 * not falsely report materialization of its untouched siblings as extra edits. */
function outsideSelection(scene: Scene, selection: DesignSelection, baseline: Scene = scene) {
  const rooms = Object.fromEntries(
    scene.rooms
      .filter(
        (room) =>
          !(
            room.id === selection.roomId &&
            selection.surface === 'room' &&
            !selection.furnitureId &&
            !selection.openingId
          ),
      )
      .map((room) => {
        const projected: Record<string, unknown> = {
          ...room,
          furniture: worldFurniture(scene, room),
          physicalOpenings: worldOpenings(scene, room, selection.openingId),
        };
        if (selection.openingId) {
          const retained = room.wallOpenings?.filter(
            (opening) => opening.id !== selection.openingId,
          );
          projected.wallOpenings = retained?.length ? retained : undefined;
          const old = baseline.rooms.find((candidate) => candidate.id === room.id);
          for (const side of wallSides) {
            const previous = old && roomOpenings(baseline, old.id, side);
            const current = roomOpenings(scene, room.id, side);
            if (
              old &&
              previous?.length === 1 &&
              previous[0].id === selection.openingId &&
              (old[side] === 'door' || old[side] === 'open' || old[side] === 'glass') &&
              (current.some((opening) => opening.id === selection.openingId) ||
                room[side] === 'solid')
            ) {
              projected[side] = 'solid';
            }
          }
        }
        if (room.id === selection.roomId) {
          if (selection.furnitureId) {
            delete (projected.furniture as Record<string, unknown>)[selection.furnitureId];
          } else if (!selection.openingId) {
            const surfaces = { ...room.surfacePalettes };
            delete surfaces[selection.surface as keyof typeof surfaces];
            projected.surfacePalettes = Object.keys(surfaces).length ? surfaces : undefined;
            if (selection.surface === 'roof') delete projected.roof;
            if (['north', 'south', 'east', 'west'].includes(selection.surface)) {
              const side = selection.surface as 'north' | 'south' | 'east' | 'west';
              delete projected[side];
              projected.physicalOpenings = worldOpenings(scene, room, undefined, side);
              // Physical world coordinates own the retained aperture comparison.
              // A local offset may change solely to keep a window in place.
              delete projected.wallOpenings;
              const alongX = side === 'east' || side === 'west';
              const center = alongX ? room.x : room.z;
              const span = alongX ? room.width : room.depth;
              projected.fixedOppositeWall = coordinate(
                center + (side === 'east' || side === 'south' ? -span / 2 : span / 2),
              );
              delete projected[alongX ? 'x' : 'z'];
              delete projected[alongX ? 'width' : 'depth'];
            }
          }
        }
        return [room.id, projected];
      }),
  );
  const projectedDesign = scene.design && {
    ...scene.design,
    connections: scene.design.connections?.filter((item) => item.id !== selection.openingId),
  };
  const design =
    projectedDesign &&
    Object.fromEntries(Object.entries(projectedDesign).filter(([, items]) => items?.length));
  return { ...scene, design: design && Object.keys(design).length ? design : undefined, rooms };
}

function differencePaths(before: unknown, after: unknown, path = '', changes: string[] = []) {
  if (canonical(before) === canonical(after)) return changes;
  if (
    before &&
    after &&
    typeof before === 'object' &&
    typeof after === 'object' &&
    !Array.isArray(before) &&
    !Array.isArray(after)
  ) {
    const a = before as Record<string, unknown>,
      b = after as Record<string, unknown>;
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (changes.length >= 30) break;
      differencePaths(a[key], b[key], path ? `${path}.${key}` : key, changes);
    }
  } else changes.push(path || 'house');
  return changes;
}

export function reviewEditScope(
  before: Scene,
  after: Scene,
  selection: DesignSelection,
): EditScopeReview {
  const changes = differencePaths(
    outsideSelection(before, selection),
    outsideSelection(after, selection, before),
  );
  return { selection, preserved: !changes.length, changes };
}

export function evaluatePreservation(
  before: Scene | undefined,
  after: Scene,
  check: PreservationAssertion,
): PreservationResult {
  if (!before)
    return {
      passed: false,
      actual: null,
      reason: 'The original draft baseline is required to verify preservation.',
    };
  if (check.kind === 'unchanged_except_selection') {
    const review = reviewEditScope(before, after, check.selection);
    return {
      passed: review.preserved,
      actual: review.changes,
      reason: review.preserved
        ? 'Everything outside the selected part matches the starting design.'
        : `Changes outside the selected part: ${review.changes.join(', ')}.`,
    };
  }
  const old = before.rooms.find((room) => room.id === check.roomId);
  const room = after.rooms.find((room) => room.id === check.roomId);
  if (!old || !room)
    return {
      passed: false,
      actual: !!room,
      reason: `Room ${check.roomId} must exist in both the baseline and draft.`,
    };
  if (check.kind === 'unchanged_surface') {
    const a = effectiveSurfacePalettes(before, old)[check.surface];
    const b = effectiveSurfacePalettes(after, room)[check.surface];
    return {
      passed: a === b,
      actual: b,
      reason:
        a === b
          ? `${room.name} ${check.surface} material is unchanged.`
          : `${room.name} ${check.surface} material changed from ${a} to ${b}.`,
    };
  }
  if (check.kind === 'unchanged_furniture') {
    const a = roomFurniture(old).find((item) => item.id === check.furnitureId);
    const b = roomFurniture(room).find((item) => item.id === check.furnitureId);
    const world = (item: typeof a, owner: Room) =>
      item && {
        ...item,
        x: coordinate(item.x + owner.x),
        z: coordinate(item.z + owner.z),
        elevation: owner.elevation,
        palette: item.palette ?? owner.palette ?? (owner === old ? before.palette : after.palette),
      };
    const passed = !!a && !!b && canonical(world(a, old)) === canonical(world(b, room));
    return {
      passed,
      actual: world(b, room) ?? null,
      reason: passed
        ? `Furniture ${check.furnitureId} is unchanged in world position and properties.`
        : `Furniture ${check.furnitureId} changed or was removed.`,
    };
  }
  if (check.kind === 'unchanged_opening') {
    const original = (worldOpenings(before, old)[check.side] as Record<string, unknown>)[
      check.openingId
    ];
    const current = (worldOpenings(after, room)[check.side] as Record<string, unknown>)[
      check.openingId
    ];
    const passed = !!original && !!current && canonical(original) === canonical(current);
    return {
      passed,
      actual: current ?? null,
      reason: passed
        ? `Opening ${check.openingId} is unchanged.`
        : `Opening ${check.openingId} changed or was removed.`,
    };
  }
  const properties = check.properties ?? preservedRoomPropertySchema.options;
  const a = roomProperties(before, old),
    b = roomProperties(after, room);
  const changed = properties.filter(
    (property) => canonical(a[property]) !== canonical(b[property]),
  );
  return {
    passed: !changed.length,
    actual: changed,
    reason: changed.length
      ? `${room.name} changed: ${changed.join(', ')}.`
      : `${room.name} matches the requested baseline properties.`,
  };
}

export function editScopeDisclosure(review: EditScopeReview) {
  return review.preserved
    ? ''
    : `The draft also changes fields outside your selected part: ${review.changes.join(', ')}. Review these additional changes before keeping the draft.`;
}

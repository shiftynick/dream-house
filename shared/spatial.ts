import type { DesignIssue } from './design.ts';
import type { Room, Scene, Side, Stair } from './model.ts';
import { roomOpenings } from './openings.ts';
import { roomFurniture, furnitureBounds, furnitureClearance } from './furniture.ts';
import { roofHeightAt } from './architecture.ts';
import {
  bounds,
  close,
  containsPoint,
  horizontalSide,
  oppositeSide,
  outdoor,
  round,
  sides,
  stairEndpoints,
} from './geometry.ts';

export type Footprint = {
  id: string;
  label: string;
  x: number;
  z: number;
  width: number;
  depth: number;
  clearance: number;
  clearanceSides: Side[];
};
type Rect = { minX: number; maxX: number; minZ: number; maxZ: number };
const DOOR_APPROACH = 0.9;
const STAIR_LANDING = 0.9;
const HEADROOM = 2;
export const spatialAssumptions = [
  'Concept checks use the saved furniture positions and dimensions; rotated items use conservative axis-aligned bounds. Rugs are not obstacles.',
  'Assumed usable door approach depth is 0.9 m; swing checks assume a single inward-swinging leaf as wide as the opening. Handing and leaf count are not modeled.',
  'Assumed stair headroom is 2 m and clear landing depth is 0.9 m. Linked stair floor and ceiling cutouts are excluded from overhead obstruction checks.',
  'Furniture circulation targets are 0.6 m, or 0.9 m around kitchen work areas. These are design assumptions, not building-code or accessibility certification.',
];

/** World-space bounds shared with the editable meshes and floor-plan symbols. */
export function furnitureFootprints(room: Room): Footprint[] {
  return roomFurniture(room)
    .filter((item) => item.kind !== 'rug')
    .map((item) => ({
      id: `${room.id}:${item.id}`,
      label: item.name,
      x: room.x + item.x,
      z: room.z + item.z,
      ...furnitureBounds(item),
      ...furnitureClearance(item),
    }));
}

const footprintRect = (item: Pick<Footprint, 'x' | 'z' | 'width' | 'depth'>): Rect => ({
  minX: item.x - item.width / 2,
  maxX: item.x + item.width / 2,
  minZ: item.z - item.depth / 2,
  maxZ: item.z + item.depth / 2,
});
const intersects = (a: Rect, b: Rect) =>
  Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX) > 0.02 &&
  Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ) > 0.02;
const rectContains = (rect: Rect, point: { x: number; z: number }) =>
  point.x >= rect.minX && point.x <= rect.maxX && point.z >= rect.minZ && point.z <= rect.maxZ;
const issue = (
  code: string,
  message: string,
  objectIds: string[],
  details: Record<string, unknown>,
): DesignIssue => ({
  code,
  severity: 'warning',
  message,
  objectIds,
  details: { ...details, advisory: true },
});

function roomObstacles(scene: Scene, room: Room) {
  const items = furnitureFootprints(room);
  if (
    scene.fireplace &&
    close(scene.fireplace.elevation, room.elevation) &&
    containsPoint(room, scene.fireplace)
  )
    items.push({
      id: 'fireplace',
      label: 'fireplace hearth',
      x: scene.fireplace.x,
      z: scene.fireplace.z,
      width: 2.4,
      depth: 1.6,
      clearance: 0.6,
      clearanceSides: sides,
    });
  return items;
}

function doors(scene: Scene, room: Room) {
  return sides.flatMap((side) => {
    const declared = roomOpenings(scene, room.id, side);
    if (declared.length)
      return declared
        .filter((opening) => opening.kind !== 'window' && opening.sill <= 0.03)
        .map((opening) => ({
          id: opening.id,
          kind: opening.kind,
          side,
          center: (horizontalSide(side) ? room.x : room.z) + opening.offset,
          width: opening.width,
        }));
    const kind = room[side];
    return kind === 'door' || kind === 'open'
      ? [
          {
            id: `${room.id}:${side}:door`,
            kind,
            side,
            center: horizontalSide(side) ? room.x : room.z,
            width: room[side] === 'open' ? (horizontalSide(side) ? room.width : room.depth) : 1.3,
          },
        ]
      : [];
  });
}

/** Local doorway coordinates: u along the wall, v inward from its face. */
function doorObstacleRect(room: Room, side: Side, center: number, item: Footprint): Rect {
  const object = footprintRect(item),
    edge = bounds(room)[side];
  if (side === 'north')
    return {
      minX: object.minX - center,
      maxX: object.maxX - center,
      minZ: object.minZ - edge,
      maxZ: object.maxZ - edge,
    };
  if (side === 'south')
    return {
      minX: object.minX - center,
      maxX: object.maxX - center,
      minZ: edge - object.maxZ,
      maxZ: edge - object.minZ,
    };
  if (side === 'west')
    return {
      minX: object.minZ - center,
      maxX: object.maxZ - center,
      minZ: object.minX - edge,
      maxZ: object.maxX - edge,
    };
  return {
    minX: object.minZ - center,
    maxX: object.maxZ - center,
    minZ: edge - object.maxX,
    maxZ: edge - object.minX,
  };
}

function blocksSwing(rect: Rect, width: number, hinge: 'left' | 'right') {
  const clipped = {
    minX: Math.max(-width / 2, rect.minX),
    maxX: Math.min(width / 2, rect.maxX),
    minZ: Math.max(0, rect.minZ),
    maxZ: Math.min(width, rect.maxZ),
  };
  if (clipped.maxX - clipped.minX <= 0.02 || clipped.maxZ - clipped.minZ <= 0.02) return false;
  const hingeX = hinge === 'left' ? -width / 2 : width / 2;
  const nearestX = Math.max(clipped.minX, Math.min(clipped.maxX, hingeX));
  return Math.hypot(nearestX - hingeX, clipped.minZ) < width - 0.02;
}

function furnitureIssues(scene: Scene, room: Room, items: Footprint[]): DesignIssue[] {
  const result: DesignIssue[] = [],
    roomBounds = bounds(room);
  for (const item of items) {
    const rect = footprintRect(item);
    const gaps = {
      north: rect.minZ - roomBounds.north,
      south: roomBounds.south - rect.maxZ,
      west: rect.minX - roomBounds.west,
      east: roomBounds.east - rect.maxX,
    };
    const outside = sides.filter((side) => gaps[side] < -0.02);
    if (outside.length)
      result.push(
        issue(
          'furniture_outside_room',
          `The ${item.label} extends outside “${room.name}” by ${round(-Math.min(...outside.map((side) => gaps[side])))} m.`,
          [room.id, item.id],
          {
            measuredClearances: gaps,
            obstructedSides: outside,
            assumption: 'Schematic mesh footprint must fit inside the room.',
          },
        ),
      );
    else {
      const tight = item.clearanceSides.filter(
        (side) => room[side] !== 'open' && gaps[side] < item.clearance - 0.02,
      );
      if (tight.length)
        result.push(
          issue(
            'furniture_wall_clearance',
            `The ${item.label} in “${room.name}” has ${round(Math.min(...tight.map((side) => gaps[side])))} m beside its ${tight.join('/')} edge; the assumed circulation target is ${item.clearance} m.`,
            [room.id, item.id],
            {
              measuredClearances: gaps,
              tightSides: tight,
              assumedTarget: item.clearance,
              assumption:
                'Clearance applies only to the listed usable sides of schematic furniture.',
            },
          ),
        );
    }
  }
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i],
        b = items[j],
        aa = footprintRect(a),
        bb = footprintRect(b);
      const xGap = Math.max(bb.minX - aa.maxX, aa.minX - bb.maxX),
        zGap = Math.max(bb.minZ - aa.maxZ, aa.minZ - bb.maxZ);
      const gap =
        xGap < 0 && zGap < 0
          ? Math.max(xGap, zGap)
          : Math.hypot(Math.max(0, xGap), Math.max(0, zGap));
      const assumedTarget = Math.max(a.clearance, b.clearance);
      if (gap < assumedTarget - 0.02)
        result.push(
          issue(
            gap < -0.02 ? 'furniture_overlap' : 'furniture_aisle_clearance',
            `The gap between the ${a.label} and ${b.label} in “${room.name}” is ${round(gap)} m; the assumed circulation target is ${assumedTarget} m.`,
            [room.id, a.id, b.id],
            {
              measuredGap: round(gap),
              assumedTarget,
              assumption:
                'Schematic bounding-box gap; negative values indicate overlapping footprints.',
            },
          ),
        );
    }
  for (const stair of scene.stairs) {
    if (
      stair.elevation >= room.elevation + room.height ||
      stair.elevation + stair.rise < room.elevation
    )
      continue;
    const rect = stairPlanFootprint(stair, 0.15);
    for (const item of items.filter((item) => item.id !== 'fireplace')) {
      if (intersects(rect, footprintRect(item)))
        result.push(
          issue(
            'furniture_stair_blocked',
            `The ${item.label} in “${room.name}” overlaps the stair footprint.`,
            [room.id, item.id, stair.id],
            { assumption: 'Keep the stair flight and its floor opening free of furniture.' },
          ),
        );
    }
  }
  for (const door of doors(scene, room)) {
    const approach = {
      minX: -Math.min(door.width, 0.9) / 2,
      maxX: Math.min(door.width, 0.9) / 2,
      minZ: 0,
      maxZ: DOOR_APPROACH,
    };
    const mapped = items.map((item) => ({
      item,
      rect: doorObstacleRect(room, door.side, door.center, item),
    }));
    const blocked = mapped.filter(({ rect }) => intersects(rect, approach));
    const availableApproach = Math.max(
      0,
      Math.min(DOOR_APPROACH, ...blocked.map(({ rect }) => rect.minZ)),
    );
    if (blocked.length)
      result.push(
        issue(
          'door_approach_blocked',
          `The ${door.side} doorway of “${room.name}” has only ${round(availableApproach)} m before a schematic obstacle; the assumed approach depth is ${DOOR_APPROACH} m.`,
          [room.id, door.id, ...blocked.map(({ item }) => item.id)],
          {
            side: door.side,
            openingCenter: door.center,
            openingWidth: door.width,
            assumedApproachDepth: DOOR_APPROACH,
            measuredAvailableDepth: round(availableApproach),
            assumption:
              'A centered 0.9 m-wide inward approach, limited to the actual opening width.',
          },
        ),
      );
    const left = mapped.filter(({ rect }) => blocksSwing(rect, door.width, 'left'));
    const right = mapped.filter(({ rect }) => blocksSwing(rect, door.width, 'right'));
    if (door.kind === 'door' && left.length && right.length)
      result.push(
        issue(
          'door_swing_obstructed',
          `Both assumed inward door swings at the ${door.side} doorway of “${room.name}” encounter schematic furniture. Consider a different opening, door type, or furnishing layout.`,
          [room.id, door.id, ...new Set([...left, ...right].map(({ item }) => item.id))],
          {
            side: door.side,
            assumedLeafWidth: door.width,
            assumption:
              'A single inward-swinging leaf equal to the opening width; hinge side and actual door type have not been specified.',
          },
        ),
      );
  }
  return result;
}

export function stairPlanFootprint(stair: Stair, margin = 0.08): Rect {
  const angle = (stair.rotation * Math.PI) / 180;
  const width = Math.abs(Math.cos(angle)) * stair.width + Math.abs(Math.sin(angle)) * stair.run;
  const depth = Math.abs(Math.sin(angle)) * stair.width + Math.abs(Math.cos(angle)) * stair.run;
  return {
    minX: stair.x - width / 2 - margin,
    maxX: stair.x + width / 2 + margin,
    minZ: stair.z - depth / 2 - margin,
    maxZ: stair.z + depth / 2 + margin,
  };
}

function stairIssues(scene: Scene): DesignIssue[] {
  const result: DesignIssue[] = [];
  for (const stair of scene.stairs) {
    const links = scene.design?.stairLinks ?? [];
    const link = links.find((link) => link.stairId === stair.id);
    const ends = stairEndpoints(stair),
      angle = (stair.rotation * Math.PI) / 180;
    const forward = { x: Math.sin(angle), z: Math.cos(angle) },
      cross = { x: Math.cos(angle), z: -Math.sin(angle) };
    const cutout = stairPlanFootprint(stair);
    let minimum = Infinity,
      obstruction: string | undefined;
    const count = Math.ceil(stair.rise / 0.18);
    for (let i = 0; i < count; i++) {
      const distance = -stair.run / 2 + ((i + 0.5) * stair.run) / count;
      const point = { x: stair.x + forward.x * distance, z: stair.z + forward.z * distance };
      const tread = stair.elevation + (stair.rise * (i + 1)) / count;
      for (const room of scene.rooms.filter((room) => !outdoor(room))) {
        if (!containsPoint(room, point)) continue;
        const top = room.elevation + room.height;
        const upperHole = link?.upperRoomId === room.id && rectContains(cutout, point);
        const ceilingHole =
          link?.lowerRoomId === room.id &&
          stair.elevation + stair.rise >= top - 0.35 &&
          rectContains(cutout, point);
        const roofCovered = scene.rooms.some(
          (other) =>
            other.id !== room.id &&
            close(other.elevation, top, 0.35) &&
            containsPoint(other, point, -0.1),
        );
        const planes = [
          ...(!upperHole ? [room.elevation - 0.3] : []),
          ...(!ceilingHole && !roofCovered
            ? [roofHeightAt(scene, room, point.x, point.z) - 0.11]
            : []),
        ];
        for (const plane of planes) {
          const clearance = plane - tread;
          if (clearance > 0.02 && clearance < minimum) {
            minimum = clearance;
            obstruction = room.id;
          }
        }
      }
    }
    if (minimum < HEADROOM - 0.02)
      result.push(
        issue(
          'stair_headroom_clearance',
          `“${stair.id}” has approximately ${round(minimum)} m of overhead clearance at its tightest sampled tread; the assumed target is ${HEADROOM} m.`,
          [stair.id, ...(obstruction ? [obstruction] : [])],
          {
            measuredMinimum: round(minimum),
            assumedTarget: HEADROOM,
            samples: count,
            assumption:
              'Schematic floor undersides and roof bases are sampled above treads; verified linked slab cutouts are excluded.',
          },
        ),
      );
    if (!link) continue;
    for (const [level, roomId, endpoint, direction] of [
      ['lower', link.lowerRoomId, ends.bottom, -1],
      ['upper', link.upperRoomId, ends.top, 1],
    ] as const) {
      const room = scene.rooms.find((r) => r.id === roomId);
      if (!room) continue;
      const points = [0.1, STAIR_LANDING].flatMap((distance) =>
        [-1, 1].map((sign) => ({
          x: endpoint.x + forward.x * distance * direction + ((cross.x * stair.width) / 2) * sign,
          z: endpoint.z + forward.z * distance * direction + ((cross.z * stair.width) / 2) * sign,
        })),
      );
      const landing = {
        minX: Math.min(...points.map((p) => p.x)),
        maxX: Math.max(...points.map((p) => p.x)),
        minZ: Math.min(...points.map((p) => p.z)),
        maxZ: Math.max(...points.map((p) => p.z)),
      };
      const obstacles = roomObstacles(scene, room).filter((item) =>
        intersects(landing, footprintRect(item)),
      );
      const outside = points.some((point) => !containsPoint(room, point));
      const box = bounds(room);
      const travel = { x: forward.x * direction, z: forward.z * direction };
      const boundaryDepth = Math.max(
        0,
        Math.min(
          ...[-1, 1].flatMap((sign) => {
            const start = {
              x: endpoint.x + ((cross.x * stair.width) / 2) * sign,
              z: endpoint.z + ((cross.z * stair.width) / 2) * sign,
            };
            return [
              ...(Math.abs(travel.x) > 1e-8
                ? [(travel.x > 0 ? box.east - start.x : box.west - start.x) / travel.x]
                : []),
              ...(Math.abs(travel.z) > 1e-8
                ? [(travel.z > 0 ? box.south - start.z : box.north - start.z) / travel.z]
                : []),
            ];
          }),
        ),
      );
      if (outside || obstacles.length)
        result.push(
          issue(
            'stair_landing_clearance',
            `The ${level} landing of “${stair.id}” needs review: its assumed ${STAIR_LANDING} m clear area ${outside ? 'extends beyond the linked room' : 'contains schematic furniture'}.`,
            [stair.id, room.id, ...obstacles.map((item) => item.id)],
            {
              landing,
              assumedDepth: STAIR_LANDING,
              measuredDepthToRoomBoundary: round(boundaryDepth),
              outsideLinkedRoom: outside,
              assumption:
                'Landing measured beyond the flight within its linked room; shared adjacent landing space is not inferred.',
            },
          ),
        );
    }
  }
  return result;
}

export function inspectRoomFurniture(scene: Scene, room: Room) {
  return furnitureIssues(scene, room, roomObstacles(scene, room));
}

export function inspectSpatial(scene: Scene) {
  const furniture = scene.rooms
    .filter((room) => !outdoor(room))
    .flatMap((room) => roomObstacles(scene, room).map((item) => ({ ...item, roomId: room.id })));
  const issues = scene.rooms
    .filter((room) => !outdoor(room))
    .flatMap((room) => furnitureIssues(scene, room, roomObstacles(scene, room)));
  issues.push(...stairIssues(scene));
  return { assumptions: spatialAssumptions, furniture, issues };
}

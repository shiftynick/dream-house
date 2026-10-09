import { z } from 'zod';
import { roomSlabs } from '../src/renderGeometry.ts';
import { paletteSchema, roomSchema, type Room, type Scene, type Side } from './model.ts';
import {
  bounds,
  close,
  containsPoint,
  horizontalSide,
  outdoor,
  round,
  sharedBoundary,
  sides,
} from './geometry.ts';
import { effectiveRoof, floorSlabBounds, roofHeightAt, roofMaximumHeight } from './architecture.ts';
import { roomOpenings, wallOpeningHeightLimit } from './openings.ts';
import { roomFurniture } from './furniture.ts';
import { validateDesign, type DesignIssue } from './design.ts';

const id = z.string().min(1).max(60);
/** Commitments are selected by the design brief. None is a universal house rule. */
export const qualityAssertionSchemas = [
  z
    .object({
      kind: z.literal('exterior_windows'),
      roomIds: z.array(id).min(1).max(32),
      minCountPerRoom: z.number().int().min(1).max(64).default(1),
      minAreaPerRoom: z.number().finite().min(0).max(300).default(0),
    })
    .strict(),
  z
    .object({
      kind: z.literal('material_composition'),
      roomIds: z.array(id).min(1).max(32).optional(),
      surfaces: z
        .array(z.enum(['exterior-walls', 'roof', 'floor']))
        .min(1)
        .max(3)
        .default(['exterior-walls']),
      allowedPalettes: z.array(paletteSchema).min(1).max(4),
      maxDistinct: z.number().int().min(1).max(4).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('room_program'),
      roomKind: roomSchema.shape.kind,
      roomIds: z.array(id).min(1).max(32).optional(),
      minCount: z.number().int().min(1).max(32).default(1),
      minArea: z.number().finite().min(0).max(900).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('feature'),
      feature: z.enum(['fireplace', 'terrace', 'courtyard', 'linked_stair']),
      roomId: id.optional(),
    })
    .strict(),
] as const;
export const qualityAssertionSchema = z.discriminatedUnion('kind', qualityAssertionSchemas);
export type QualityAssertion = z.infer<typeof qualityAssertionSchema>;
export function isQualityAssertion(value: { kind: string }): value is QualityAssertion {
  return ['exterior_windows', 'material_composition', 'room_program', 'feature'].includes(
    value.kind,
  );
}
export type QualityAssertionResult = { passed: boolean; actual: unknown; reason: string };

type WallRect = { start: number; end: number; bottom: number; top: number };
const EPSILON = 0.0001;
function area(rect: WallRect) {
  return Math.max(0, rect.end - rect.start) * Math.max(0, rect.top - rect.bottom);
}
function subtract(base: WallRect[], cuts: WallRect[]) {
  return cuts.reduce(
    (pieces, cut) =>
      pieces.flatMap((rect) => {
        const start = Math.max(rect.start, cut.start),
          end = Math.min(rect.end, cut.end);
        const bottom = Math.max(rect.bottom, cut.bottom),
          top = Math.min(rect.top, cut.top);
        if (end - start <= EPSILON || top - bottom <= EPSILON) return [rect];
        return [
          { ...rect, end: start },
          { ...rect, start: end },
          { start, end, bottom: rect.bottom, top: bottom },
          { start, end, bottom: top, top: rect.top },
        ].filter((piece) => area(piece) > EPSILON);
      }),
    base,
  );
}
function axis(room: Room, side: Side) {
  const center = horizontalSide(side) ? room.x : room.z;
  const length = horizontalSide(side) ? room.width : room.depth;
  return { center, length };
}
function openingRect(
  room: Room,
  side: Side,
  opening: { offset: number; width: number; sill: number; height: number },
): WallRect {
  const center = axis(room, side).center + opening.offset;
  return {
    start: center - opening.width / 2,
    end: center + opening.width / 2,
    bottom: room.elevation + opening.sill,
    top: room.elevation + opening.sill + opening.height,
  };
}
/** Indoor volume, not the neighbor's wall flag, blocks direct exterior exposure.
 * Use its maximum roof elevation conservatively; this may undercount clerestory
 * exposure beside a sloping roof but never invents daylight through another room. */
function profileHeight(scene: Scene, room: Room, side: Side, coordinate: number) {
  const plane = bounds(room)[side];
  return roofHeightAt(
    scene,
    room,
    horizontalSide(side) ? coordinate : plane,
    horizontalSide(side) ? plane : coordinate,
  );
}
function enclosureCuts(scene: Scene, room: Room, side: Side, possibleExposure = false): WallRect[] {
  return scene.rooms.flatMap((other) => {
    if (other.id === room.id) return [];
    const shared = sharedBoundary(room, other);
    if (!shared || shared.sideA !== side) return [];
    // An outdoor room's nominal height and wall flags are not an enclosure.
    // Its actual raised deck can still cover part of a neighboring aperture.
    if (outdoor(other))
      return [{ start: shared.start, end: shared.end, ...floorSlabBounds(other) }];
    return [
      {
        start: shared.start,
        end: shared.end,
        bottom: other.elevation,
        // Minimum boundary height gives an upper bound on possible exposed
        // material. A maximum-height cut is only safe for minimum glazing area.
        top: possibleExposure
          ? Math.min(
              profileHeight(scene, other, shared.sideB, shared.start),
              profileHeight(scene, other, shared.sideB, shared.end),
            )
          : roofMaximumHeight(scene, other),
      },
    ];
  });
}
function localRect(room: Room, side: Side, rect: WallRect) {
  return {
    offset: round((rect.start + rect.end) / 2 - axis(room, side).center),
    width: round(rect.end - rect.start),
    sill: round(rect.bottom - room.elevation),
    height: round(rect.top - rect.bottom),
  };
}
const totalArea = (rects: WallRect[]) => rects.reduce((sum, rect) => sum + area(rect), 0);

/** Integrate the piecewise-linear roof-wall cap after rectangular occlusions.
 * Split at profile corners, cut edges and every height crossing, so trapezoid
 * integration is exact for these rectangular cuts (including overlapping cuts). */
function capArea(scene: Scene, room: Room, side: Side, cuts: WallRect[]) {
  if (outdoor(room) || effectiveRoof(scene, room).style === 'flat') return 0;
  const { center, length } = axis(room, side);
  const start = center - length / 2,
    end = center + length / 2;
  const bottom = room.elevation + room.height;
  const xs = [...new Set([start, center, end, ...cuts.flatMap((cut) => [cut.start, cut.end])])]
    .filter((x) => x >= start && x <= end)
    .sort((a, b) => a - b);
  let result = 0;
  for (let i = 1; i < xs.length; i++) {
    const left = xs[i - 1],
      right = xs[i],
      middle = (left + right) / 2;
    const active = cuts.filter((cut) => cut.start < middle && cut.end > middle);
    const h0 = profileHeight(scene, room, side, left),
      h1 = profileHeight(scene, room, side, right);
    const breakpoints = [left, right];
    if (Math.abs(h1 - h0) > EPSILON)
      for (const y of [bottom, ...active.flatMap((cut) => [cut.bottom, cut.top])]) {
        const fraction = (y - h0) / (h1 - h0);
        if (fraction > 0 && fraction < 1) breakpoints.push(left + fraction * (right - left));
      }
    breakpoints.sort((a, b) => a - b);
    const exposedHeight = (x: number) => {
      const top = profileHeight(scene, room, side, x);
      if (top <= bottom) return 0;
      return totalArea(
        subtract(
          [{ start: 0, end: 1, bottom, top }],
          active.map((cut) => ({ ...cut, start: 0, end: 1 })),
        ),
      );
    };
    for (let j = 1; j < breakpoints.length; j++)
      result +=
        ((breakpoints[j] - breakpoints[j - 1]) *
          (exposedHeight(breakpoints[j]) + exposedHeight(breakpoints[j - 1]))) /
        2;
  }
  return result;
}

function wallEvidence(scene: Scene, room: Room, side: Side) {
  const { center, length } = axis(room, side);
  const wall = {
    start: center - length / 2,
    end: center + length / 2,
    bottom: room.elevation,
    top: room.elevation + room.height,
  };
  const cuts = enclosureCuts(scene, room, side);
  const exposed = outdoor(room) ? [] : subtract([wall], cuts);
  const openings = roomOpenings(scene, room.id, side);
  const windows = openings
    .filter((opening) => opening.kind === 'window')
    .map((opening) => {
      const rect = openingRect(room, side, opening);
      const fits =
        opening.width > 0 &&
        opening.height > 0 &&
        opening.sill >= 0 &&
        Math.abs(opening.offset) + opening.width / 2 <= length / 2 + EPSILON &&
        opening.sill + opening.height <=
          wallOpeningHeightLimit(scene, room, side, opening.offset, opening.width) + EPSILON;
      const overlapping = openings.some((other) => {
        if (other === opening) return false;
        const b = openingRect(room, side, other);
        return (
          Math.min(rect.end, b.end) - Math.max(rect.start, b.start) > EPSILON &&
          Math.min(rect.top, b.top) - Math.max(rect.bottom, b.bottom) > EPSILON
        );
      });
      const pieces = fits && !overlapping && !outdoor(room) ? subtract([rect], cuts) : [];
      return {
        id: opening.id,
        side,
        sourceRoomId: opening.sourceRoomId,
        offset: opening.offset,
        width: opening.width,
        height: opening.height,
        sill: opening.sill,
        validDimensions: fits && !overlapping,
        exposedArea: round(totalArea(pieces)),
        exteriorPieces: pieces.map((piece) => localRect(room, side, piece)),
      };
    });
  const openingCuts = openings.map((opening) => openingRect(room, side, opening));
  if (!openings.length && room[side] === 'door')
    openingCuts.push(
      openingRect(room, side, {
        offset: 0,
        width: Math.min(1.3, length),
        sill: 0,
        height: Math.min(2.4, room.height),
      }),
    );
  const wholeGlass = !openings.length && room[side] === 'glass';
  const wholeOpen = !openings.length && room[side] === 'open';
  const opaque = wholeGlass || wholeOpen ? [] : subtract(exposed, openingCuts);
  const materialCuts = enclosureCuts(scene, room, side, true);
  const possibleOpaque =
    outdoor(room) || wholeGlass || wholeOpen
      ? []
      : subtract([wall], [...materialCuts, ...openingCuts]);
  const opaqueCapArea =
    wholeGlass || wholeOpen ? 0 : capArea(scene, room, side, [...cuts, ...openingCuts]);
  const possibleOpaqueCapArea =
    wholeGlass || wholeOpen ? 0 : capArea(scene, room, side, [...materialCuts, ...openingCuts]);
  return {
    side,
    flag: room[side],
    exteriorWallArea: round(totalArea(exposed)),
    // Candidate rectangles are geometric wall exposure, not automatic permission
    // to overwrite doors/windows or a guarantee of daylight performance.
    exposedWallRectangles: exposed.map((rect) => localRect(room, side, rect)),
    availableWindowRectangles: (wholeGlass || wholeOpen ? [] : subtract(exposed, openingCuts)).map(
      (rect) => localRect(room, side, rect),
    ),
    opaqueExteriorArea: round(totalArea(opaque) + opaqueCapArea),
    opaqueCapArea: round(opaqueCapArea),
    possibleOpaqueExteriorArea: round(totalArea(possibleOpaque) + possibleOpaqueCapArea),
    palette: room.surfacePalettes?.[side] ?? room.palette ?? scene.palette,
    paletteSource: room.surfacePalettes?.[side]
      ? ('surface' as const)
      : room.palette
        ? ('room' as const)
        : ('house' as const),
    legacyExteriorGlazingArea: wholeGlass ? round(totalArea(exposed)) : 0,
    windows,
  };
}

function verifiedStairLinks(scene: Scene, issues: DesignIssue[]) {
  return (scene.design?.stairLinks ?? []).filter((link) => {
    const stair = scene.stairs.find((item) => item.id === link.stairId);
    const lower = scene.rooms.find((item) => item.id === link.lowerRoomId);
    const upper = scene.rooms.find((item) => item.id === link.upperRoomId);
    if (!stair || !lower || !upper || lower.id === upper.id || outdoor(lower) || outdoor(upper))
      return false;
    return !issues.some((issue) => issue.objectIds.includes(link.stairId));
  });
}

/** Factual evidence for planning and critique. This does not certify style,
 * comfort, code compliance, daylight, weatherproofing, or render visibility. */
/** Conservative architectural grouping, not a structural or circulation check.
 * Only a flat lower ceiling with a coincident upper footprint is counted as a
 * covered core. Roof perimeter overhangs can remain visible in the renderer. */
function stackedVolumeEvidence(scene: Scene) {
  const enclosed = scene.rooms.filter((room) => !outdoor(room));
  const roomBounds = new Map(scene.rooms.map((room) => [room, bounds(room)]));
  const above = new Map(enclosed.map((room) => [room, [] as Room[]]));
  const below = new Map(enclosed.map((room) => [room, [] as Room[]]));
  for (const lower of enclosed) {
    if (effectiveRoof(scene, lower).style !== 'flat') continue;
    for (const upper of enclosed) {
      if (upper === lower || !close(lower.elevation + lower.height, upper.elevation, EPSILON))
        continue;
      if (
        !sides.every((side) =>
          close(roomBounds.get(lower)![side], roomBounds.get(upper)![side], EPSILON),
        )
      )
        continue;
      above.get(lower)!.push(upper);
      below.get(upper)!.push(lower);
    }
  }
  return enclosed
    .filter((room) => below.get(room)!.length === 0)
    .flatMap((base) => {
      const layers = [base];
      while (true) {
        const candidates = above.get(layers[layers.length - 1])!;
        if (candidates.length !== 1 || below.get(candidates[0])!.length !== 1) break;
        layers.push(candidates[0]);
      }
      if (layers.length < 2) return [];
      const top = layers[layers.length - 1];
      const footprint = roomBounds.get(top)!;
      const higherOverlappingRooms = scene.rooms.filter((other) => {
        if (layers.includes(other) || other.elevation <= top.elevation + EPSILON) return false;
        const otherBounds = roomBounds.get(other)!;
        return (
          Math.min(footprint.east, otherBounds.east) - Math.max(footprint.west, otherBounds.west) >
            EPSILON &&
          Math.min(footprint.south, otherBounds.south) -
            Math.max(footprint.north, otherBounds.north) >
            EPSILON
        );
      });
      const wallFacts = (room: Room) => ({
        roomId: room.id,
        baseElevation: room.elevation,
        eaveElevation: room.elevation + room.height,
        height: room.height,
        palettes: Object.fromEntries(
          sides.map((side) => [
            side,
            room.surfacePalettes?.[side] ?? room.palette ?? scene.palette,
          ]),
        ),
      });
      const roofClipped = roomSlabs(scene, top).roofClipped;
      const topRoof = {
        profileBasis: 'nominal unclipped architectural roof',
        roomId: top.id,
        ...effectiveRoof(scene, top),
        palette: top.surfacePalettes?.roof ?? top.palette ?? scene.palette,
        eaveElevation: top.elevation + top.height,
        maximumElevation: roofMaximumHeight(scene, top),
      };
      return [
        {
          roomIds: layers.map((room) => room.id),
          footprint: { x: base.x, z: base.z, width: base.width, depth: base.depth },
          lowerBase: wallFacts(base),
          layers: layers.map(wallFacts),
          topWalls: wallFacts(top),
          topRoof,
          topVisibleRoof: roofClipped || higherOverlappingRooms.length ? null : topRoof,
          roofClipped,
          roofVisibility: roofClipped
            ? 'renderer clips this roof into flat exposed patches; nominal roof profile is not the rendered roof'
            : higherOverlappingRooms.length
              ? 'qualified by higher overlapping room footprints'
              : 'top roof core has no higher overlapping room footprint; camera visibility is not assessed',
          higherOverlappingRoomIds: higherOverlappingRooms.map((room) => room.id),
          totalHeight:
            (roofClipped ? top.elevation + top.height : roofMaximumHeight(scene, top)) -
            base.elevation,
          coveredLowerRoofs: layers.slice(0, -1).map((room, index) => ({
            roomId: room.id,
            style: effectiveRoof(scene, room).style,
            elevation: room.elevation + room.height,
            coveredByRoomId: layers[index + 1].id,
            coverage: 'coincident footprint core; perimeter roof overhangs may remain visible',
          })),
        },
      ];
    });
}

export function inspectDesignQuality(scene: Scene) {
  const rooms = scene.rooms.map((room) => {
    const walls = sides.map((side) => wallEvidence(scene, room, side));
    const windows = walls
      .flatMap((wall) => wall.windows)
      .filter((item) => item.exposedArea > EPSILON);
    return {
      id: room.id,
      name: room.name,
      kind: room.kind,
      area: round(room.width * room.depth),
      enclosed: !outdoor(room),
      walls,
      exteriorWindowCount: windows.length,
      exteriorWindowArea: round(windows.reduce((sum, item) => sum + item.exposedArea, 0)),
      legacyExteriorGlazingArea: round(
        walls.reduce((sum, item) => sum + item.legacyExteriorGlazingArea, 0),
      ),
      furnitureKinds: [...new Set(roomFurniture(room).map((item) => item.kind))],
      furnitureMode: room.furniture === undefined ? ('generated' as const) : ('explicit' as const),
      roof: effectiveRoof(scene, room),
      wallHeight: room.height,
      roofMaximumElevation: roofMaximumHeight(scene, room),
      floorPalette:
        outdoor(room) && !room.surfacePalettes?.floor && !room.palette
          ? null
          : (room.surfacePalettes?.floor ?? room.palette ?? scene.palette),
      floorPaletteSource: room.surfacePalettes?.floor
        ? 'surface'
        : room.palette
          ? 'room'
          : outdoor(room)
            ? 'renderer-deck-default'
            : 'house',
      roofPalette: room.surfacePalettes?.roof ?? room.palette ?? scene.palette,
    };
  });
  const fireplaceRoomIds = scene.fireplace
    ? scene.rooms
        .filter(
          (room) =>
            !outdoor(room) &&
            containsPoint(room, scene.fireplace!) &&
            close(room.elevation, scene.fireplace!.elevation),
        )
        .map((room) => room.id)
    : [];
  const stairIds = new Set((scene.design?.stairLinks ?? []).map((link) => link.stairId));
  const stairLinkIssues = stairIds.size
    ? validateDesign(scene).filter(
        (issue) => issue.severity === 'error' && issue.objectIds.some((id) => stairIds.has(id)),
      )
    : [];
  return {
    rooms,
    stackedVolumes: stackedVolumeEvidence(scene),
    program: Object.fromEntries(
      roomSchema.shape.kind.options.map((kind) => [
        kind,
        rooms.filter((room) => room.kind === kind).map((room) => room.id),
      ]),
    ),
    features: {
      fireplace: scene.fireplace,
      fireplaceRoomIds,
      terraceRoomIds: rooms.filter((room) => room.kind === 'terrace').map((room) => room.id),
      courtyardRoomIds: rooms.filter((room) => room.kind === 'courtyard').map((room) => room.id),
      verifiedStairLinks: verifiedStairLinks(scene, stairLinkIssues),
      stairLinkIssues,
    },
    limitations: [
      'Stacked volumes group only coincident enclosed footprints with adjacent elevations and flat covered lower roofs at 0.0001 m tolerance. Offset or partial stacks are omitted. Roof profiles are nominal architectural geometry; overhang ledges, camera visibility, structural support and circulation are not certified.',
      'Exterior glazing is a geometric exposure proxy, not measured daylight or a code check. Only explicit dimensioned windows count; doors, open gaps, shared indoor glazing and legacy whole-wall glass do not count as windows.',
      'Adjacent enclosed volumes block exposure regardless of wall flags. Maximum neighboring roof height is conservative near slopes; overhangs, distant obstructions, orientation and transmission are not modeled.',
      'Wall placement rectangles stop at nominal eaves and exclude whole-wall open/glass faces. Material evidence includes raised/gable caps; possible exposure uses a conservative minimum neighboring roof edge, so uncertain palettes cannot silently pass. Roof/floor palettes are assigned surfaces, not proof those surfaces are visible in a capture.',
      'Room kinds and furniture inventories are program evidence, not proof of functional completeness. Palette membership and counts verify declared commitments, not aesthetic coherence.',
      'Outdoor floors without a room/floor override use the renderer default deck, not the house palette; their named floorPalette is null until explicitly assigned. Linked stairs must pass existing landing/opening validation, not structural or code certification.',
    ],
  };
}

export function evaluateQualityAssertion(
  scene: Scene,
  assertion: QualityAssertion,
): QualityAssertionResult {
  const inspection = inspectDesignQuality(scene);
  if (assertion.kind === 'exterior_windows') {
    const actual = [...new Set(assertion.roomIds)].map((id) => {
      const room = inspection.rooms.find((item) => item.id === id);
      return {
        roomId: id,
        exists: !!room,
        count: room?.exteriorWindowCount ?? 0,
        area: room?.exteriorWindowArea ?? 0,
      };
    });
    const passed = actual.every(
      (room) =>
        room.exists &&
        room.count >= assertion.minCountPerRoom &&
        room.area + EPSILON >= assertion.minAreaPerRoom,
    );
    return {
      passed,
      actual,
      reason: passed
        ? 'Each requested room has the committed dimensioned exterior windows and exposed glazing area; daylight performance remains unverified.'
        : 'At least one requested room lacks the committed real exterior windows or exposed glazing area. Open gaps, interior windows and whole-wall glass do not satisfy this check.',
    };
  }
  if (assertion.kind === 'room_program') {
    const missingRoomIds =
      assertion.roomIds?.filter((id) => !inspection.rooms.some((room) => room.id === id)) ?? [];
    const actual = inspection.rooms
      .filter(
        (room) =>
          (!assertion.roomIds || assertion.roomIds.includes(room.id)) &&
          room.kind === assertion.roomKind &&
          room.area + EPSILON >= (assertion.minArea ?? 0),
      )
      .map((room) => ({ roomId: room.id, area: room.area, furnitureKinds: room.furnitureKinds }));
    return {
      passed: !missingRoomIds.length && actual.length >= assertion.minCount,
      actual,
      reason: missingRoomIds.length
        ? `Requested program rooms are missing: ${missingRoomIds.join(', ')}. Create these planned rooms before claiming the program is complete.`
        : `${actual.length} ${assertion.roomIds ? 'targeted ' : ''}room(s) have the requested ${assertion.roomKind} use${assertion.minArea === undefined ? '' : ` and at least ${assertion.minArea} m² each`}. This verifies declared use and area, not furnishing or functional completeness.`,
    };
  }
  if (assertion.kind === 'feature') {
    const features = inspection.features;
    const ids =
      assertion.feature === 'fireplace'
        ? features.fireplaceRoomIds
        : assertion.feature === 'terrace'
          ? features.terraceRoomIds
          : assertion.feature === 'courtyard'
            ? features.courtyardRoomIds
            : features.verifiedStairLinks.flatMap((link) => [link.lowerRoomId, link.upperRoomId]);
    return {
      passed: assertion.roomId ? ids.includes(assertion.roomId) : ids.length > 0,
      actual:
        assertion.feature === 'fireplace'
          ? { fireplace: features.fireplace, roomIds: ids }
          : assertion.feature === 'linked_stair'
            ? { links: features.verifiedStairLinks, issues: features.stairLinkIssues }
            : ids,
      reason:
        assertion.feature === 'linked_stair' && features.stairLinkIssues.length
          ? `Linked stair validation reports: ${features.stairLinkIssues.map((issue) => issue.message).join(' ')}`
          : `Checks modeled ${assertion.feature} presence${assertion.roomId ? ` in ${assertion.roomId}` : ''}; no visual, structural or code certification.`,
    };
  }
  const selected = assertion.roomIds
    ? inspection.rooms.filter((room) => assertion.roomIds!.includes(room.id))
    : inspection.rooms;
  const assignments = selected.flatMap((room) =>
    assertion.surfaces.flatMap((surface) =>
      surface === 'exterior-walls'
        ? room.walls
            .filter((wall) => wall.possibleOpaqueExteriorArea > EPSILON)
            .map((wall) => ({
              roomId: room.id,
              surface: wall.side as string,
              palette: wall.palette,
              area: wall.possibleOpaqueExteriorArea,
            }))
        : surface === 'roof' && !room.enclosed
          ? []
          : [
              {
                roomId: room.id,
                surface: surface as string,
                palette: surface === 'roof' ? room.roofPalette : room.floorPalette,
                area: room.area,
              },
            ],
    ),
  );
  const palettes = [...new Set(assignments.map((item) => item.palette))];
  const missingRoomIds =
    assertion.roomIds?.filter((id) => !selected.some((room) => room.id === id)) ?? [];
  const outsideScheme = assignments.filter(
    (item) => item.palette === null || !assertion.allowedPalettes.includes(item.palette),
  );
  const passed =
    !missingRoomIds.length &&
    assignments.length > 0 &&
    !outsideScheme.length &&
    (assertion.maxDistinct === undefined || palettes.length <= assertion.maxDistinct);
  return {
    passed,
    actual: { palettes, assignments, outsideScheme, missingRoomIds },
    reason: passed
      ? 'Assigned materials satisfy the declared palette set/count. Primary/accent balance and visual coherence still require critique.'
      : assignments.some((item) => item.palette === null)
        ? 'An outdoor floor uses the renderer default deck. Assign an explicit room or floor palette before claiming a named material composition.'
        : 'Requested surfaces are absent, exceed the declared material count, or use palettes outside the declared composition.',
  };
}

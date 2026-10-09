import assert from 'node:assert/strict';
import test from 'node:test';
import { roomSlabs } from '../src/renderGeometry';
import { emptyScene, makeRoom, type Room, type Scene } from '../shared/model';
import { validateDesign } from '../shared/design';
import {
  inspectDesignQuality,
  evaluateQualityAssertion,
  qualityAssertionSchema,
  type QualityAssertion,
} from '../shared/design-quality';

const room = (patch: Partial<Room> = {}) =>
  makeRoom({
    id: 'a',
    x: 0,
    z: 0,
    width: 8,
    depth: 6,
    height: 3,
    elevation: 0,
    north: 'solid',
    south: 'solid',
    east: 'solid',
    west: 'solid',
    furniture: [],
    ...patch,
  });
const house = (...rooms: Room[]): Scene => ({
  ...structuredClone(emptyScene),
  roof: 'flat',
  fireplace: null,
  rooms,
});
const window = (patch: Partial<NonNullable<Room['wallOpenings']>[number]> = {}) => ({
  id: 'w',
  side: 'south' as const,
  kind: 'window' as const,
  offset: 0,
  width: 2,
  height: 1,
  sill: 1,
  ...patch,
});
const check = (scene: Scene, value: unknown) =>
  evaluateQualityAssertion(scene, qualityAssertionSchema.parse(value));
const glazing = (roomIds = ['a'], minAreaPerRoom = 0) => ({
  kind: 'exterior_windows',
  roomIds,
  minAreaPerRoom,
});

test('a roofed core with open passages, legacy doors and whole-wall glass does not meet a real-window commitment', () => {
  const source = house(
    room({ south: 'open', north: 'glass', east: 'door', roof: { style: 'pitched', pitch: 28 } }),
  );
  assert.equal(check(source, glazing()).passed, false);
  const evidence = inspectDesignQuality(source).rooms[0];
  assert.equal(evidence.exteriorWindowCount, 0);
  assert.equal(evidence.legacyExteriorGlazingArea, 24);
  assert.equal(evidence.walls.find((wall) => wall.side === 'north')!.legacyExteriorGlazingArea, 24);
  assert.ok(
    inspectDesignQuality(source).limitations.some((item) => /not measured daylight/.test(item)),
  );
});

test('explicit exposed windows prove count and dimensioned area for every requested room, never missing rooms', () => {
  const source = house(room({ wallOpenings: [window()] }), room({ id: 'b', x: 12 }));
  assert.equal(check(source, glazing(['a'], 2)).passed, true);
  assert.equal(check(source, glazing(['a'], 2.1)).passed, false);
  assert.equal(check(source, glazing(['a', 'b'])).passed, false);
  assert.equal(check(source, glazing(['missing'])).passed, false);
  assert.equal(check(source, { ...glazing(), minCountPerRoom: 2 }).passed, false);
  const windowEvidence = inspectDesignQuality(source).rooms[0].walls.find(
    (wall) => wall.side === 'south',
  )!.windows[0];
  assert.equal(windowEvidence.width, 2);
  assert.equal(windowEvidence.height, 1);
  assert.equal(windowEvidence.exposedArea, 2);
});

test('a shared indoor window is not exterior daylight on either side, even with open neighbor wall flags', () => {
  const source = house(room({ wallOpenings: [window()] }), room({ id: 'b', z: 6, north: 'open' }));
  for (const id of ['a', 'b']) assert.equal(check(source, glazing([id])).passed, false);
  assert.equal(inspectDesignQuality(source).rooms[1].walls[0].windows[0].sourceRoomId, 'a');
});

test('partial and overlapping neighbors subtract exposure once and supply useful free wall rectangles', () => {
  const source = house(
    room({ wallOpenings: [window({ offset: 2 })] }),
    room({ id: 'b', x: -2, z: 5, width: 4, depth: 4 }),
    room({ id: 'c', x: -3, z: 5, width: 2, depth: 4 }),
  );
  const wall = inspectDesignQuality(source).rooms[0].walls.find((wall) => wall.side === 'south')!;
  assert.equal(wall.exteriorWallArea, 12);
  assert.equal(wall.windows[0].exposedArea, 2);
  assert.deepEqual(wall.exposedWallRectangles, [{ offset: 2, width: 4, sill: 0, height: 3 }]);
  assert.equal(
    wall.availableWindowRectangles.reduce((sum, rect) => sum + rect.width * rect.height, 0),
    10,
  );
  assert.ok(wall.availableWindowRectangles.every((rect) => rect.offset - rect.width / 2 >= 0));
});

test('courtyards and terraces are exterior while vertically disjoint indoor rooms do not occlude windows', () => {
  for (const patch of [
    { kind: 'terrace' as const },
    { kind: 'courtyard' as const },
    { elevation: 3 },
  ]) {
    const source = house(room({ wallOpenings: [window()] }), room({ id: 'b', z: 6, ...patch }));
    assert.equal(check(source, glazing(['a'], 2)).passed, true);
  }
  assert.equal(
    check(house(room({ kind: 'terrace', wallOpenings: [window()] })), glazing()).passed,
    false,
  );
});

test('tall-room clerestories count above a lower enclosure; neighboring sloping roofs use a conservative maximum', () => {
  const a = room({ height: 6, wallOpenings: [window({ sill: 4 })] });
  const b = room({ id: 'b', z: 6 });
  assert.equal(check(house(a, b), glazing(['a'], 2)).passed, true);
  b.roof = { style: 'single-pitch', pitch: 30, direction: 'south' };
  assert.equal(check(house(a, b), glazing()).passed, false);
});

test('invalid and overlapping apertures cannot inflate dimensioned-window counts or area', () => {
  for (const apertures of [
    [window({ offset: 4 })],
    [window({ sill: 2.5 })],
    [window(), window({ id: 'overlap', offset: 0.5 })],
    [window({ kind: 'door', sill: 0, height: 2.2 })],
  ])
    assert.equal(check(house(room({ wallOpenings: apertures })), glazing()).passed, false);
});

test('bounded material commitments allow deliberate accents but identify inherited room-wide palette departures', () => {
  const source = house(room({ palette: 'cedar', surfacePalettes: { south: 'limestone' } }));
  const assertion = {
    kind: 'material_composition',
    allowedPalettes: ['cedar', 'limestone'],
    maxDistinct: 2,
  };
  assert.equal(check(source, assertion).passed, true);
  assert.equal(check(source, { ...assertion, allowedPalettes: ['cedar'] }).passed, false);
  assert.equal(check(source, { ...assertion, maxDistinct: 1 }).passed, false);
  source.rooms.push(room({ id: 'b', x: 12, palette: 'charcoal' }));
  const failed = check(source, assertion);
  assert.equal(failed.passed, false);
  assert.ok(
    (failed.actual as { outsideScheme: { roomId: string }[] }).outsideScheme.every(
      (item) => item.roomId === 'b',
    ),
  );
  assert.equal(check(source, { ...assertion, roomIds: ['a'] }).passed, true);
  assert.equal(check(source, { ...assertion, roomIds: ['missing'] }).passed, false);
});

test('exterior material evidence excludes fully enclosed walls and empty/glazed faces, with roof/floor scopes explicit', () => {
  const center = room({ width: 4, depth: 4, palette: 'charcoal' });
  const source = house(
    center,
    ...[{ x: -4 }, { x: 4 }, { z: -4 }, { z: 4 }].map((position, index) =>
      room({ id: `b${index}`, width: 4, depth: 4, palette: 'cedar', ...position }),
    ),
  );
  assert.equal(
    check(source, { kind: 'material_composition', allowedPalettes: ['cedar'] }).passed,
    true,
  );
  assert.equal(
    check(source, { kind: 'material_composition', surfaces: ['floor'], allowedPalettes: ['cedar'] })
      .passed,
    false,
  );
  center.surfacePalettes = { roof: 'limestone', floor: 'cedar' };
  assert.equal(
    check(source, {
      kind: 'material_composition',
      roomIds: ['a'],
      surfaces: ['roof'],
      allowedPalettes: ['limestone'],
    }).passed,
    true,
  );
  const noWalls = house(room({ north: 'open', south: 'glass', east: 'open', west: 'glass' }));
  assert.equal(
    check(noWalls, { kind: 'material_composition', allowedPalettes: ['limestone'] }).passed,
    false,
  );
});

test('program evidence checks actual declared use and per-room area, without inventing a universal room schedule', () => {
  const source = house(room({ name: 'Bedroom', kind: 'living' }));
  assert.equal(check(source, { kind: 'room_program', roomKind: 'bedroom' }).passed, false);
  assert.equal(
    check(source, { kind: 'room_program', roomKind: 'living', minArea: 48 }).passed,
    true,
  );
  assert.equal(
    check(source, { kind: 'room_program', roomKind: 'living', minArea: 49 }).passed,
    false,
  );
  assert.equal(
    check(source, { kind: 'room_program', roomKind: 'living', minCount: 2 }).passed,
    false,
  );
  assert.equal(inspectDesignQuality(source).rooms[0].furnitureMode, 'explicit');
  assert.deepEqual(inspectDesignQuality(source).rooms[0].furnitureKinds, []);
});

test('visible gable and raised wall caps cannot disappear from material commitments behind flat neighbors', () => {
  for (const style of ['pitched', 'single-pitch'] as const)
    for (const direction of ['north', 'south', 'east', 'west'] as const) {
      const center = room({
        width: 4,
        depth: 4,
        palette: 'charcoal',
        roof: { style, pitch: 30, direction },
      });
      const neighbors = [{ x: -4 }, { x: 4 }, { z: -4 }, { z: 4 }].map((position, index) =>
        room({ id: `n${index}`, width: 4, depth: 4, palette: 'cedar', ...position }),
      );
      const source = house(center, ...neighbors);
      const evidence = inspectDesignQuality(source).rooms[0];
      assert.ok(evidence.walls.every((wall) => wall.exteriorWallArea === 0));
      assert.ok(evidence.walls.reduce((sum, wall) => sum + wall.opaqueCapArea, 0) > 4);
      assert.equal(
        check(source, { kind: 'material_composition', allowedPalettes: ['cedar'] }).passed,
        false,
      );
      assert.equal(
        check(source, { kind: 'material_composition', allowedPalettes: ['cedar', 'charcoal'] })
          .passed,
        true,
      );
      for (const neighbor of neighbors) neighbor.height = 6;
      assert.equal(
        check(source, { kind: 'material_composition', allowedPalettes: ['cedar'] }).passed,
        true,
      );
    }
});

test('cap area subtracts raised apertures and material evidence does not hide a gable behind a neighbor roof maximum', () => {
  const center = room({
    width: 4,
    depth: 4,
    palette: 'charcoal',
    roof: { style: 'pitched', pitch: 30, direction: 'north' },
    wallOpenings: [window({ side: 'east', width: 1, height: 0.5, sill: 3 })],
  });
  const neighbor = room({ id: 'n', x: 4, width: 4, depth: 4, palette: 'cedar' });
  const source = house(center, neighbor);
  let east = inspectDesignQuality(source).rooms[0].walls.find((wall) => wall.side === 'east')!;
  assert.ok(Math.abs(east.opaqueCapArea - (4 * Math.tan(Math.PI / 6) - 0.5)) < 0.0001);
  neighbor.roof = { style: 'single-pitch', pitch: 45, direction: 'east' };
  east = inspectDesignQuality(source).rooms[0].walls.find((wall) => wall.side === 'east')!;
  assert.equal(east.opaqueCapArea, 0, 'minimum exposure remains conservative beside slopes');
  assert.ok(
    east.possibleOpaqueExteriorArea > 1.8,
    'a high remote roof edge cannot hide the actual low shared edge from material checks',
  );
});

test('whole-wall open and glass faces are not vacant window-placement slots', () => {
  for (const flag of ['open', 'glass', 'solid', 'door'] as const) {
    const source = house(room({ width: 4, depth: 4, south: flag }));
    const south = inspectDesignQuality(source).rooms[0].walls.find(
      (wall) => wall.side === 'south',
    )!;
    assert.equal(south.exposedWallRectangles.length, 1);
    if (flag === 'open' || flag === 'glass') assert.deepEqual(south.availableWindowRectangles, []);
    else assert.ok(south.availableWindowRectangles.length > 0);
  }
});

test('targeted program commitments cannot borrow room kinds or area from unplanned rooms', () => {
  const source = house(
    room({ id: 'planned-bedroom', kind: 'living' }),
    room({ id: 'unplanned-bedroom', kind: 'bedroom', x: 12 }),
  );
  const assertion = { kind: 'room_program', roomKind: 'bedroom', minCount: 1 };
  assert.equal(check(source, assertion).passed, true);
  assert.equal(check(source, { ...assertion, roomIds: ['planned-bedroom'] }).passed, false);
  source.rooms[0].kind = 'bedroom';
  assert.equal(check(source, { ...assertion, roomIds: ['planned-bedroom'] }).passed, true);
  source.rooms[0].width = 2;
  assert.equal(
    check(source, { ...assertion, roomIds: ['planned-bedroom'], minArea: 20 }).passed,
    false,
  );
  assert.equal(check(source, { ...assertion, minArea: 20 }).passed, true);
  const missing = check(source, { ...assertion, roomIds: ['unplanned-bedroom', 'missing'] });
  assert.equal(missing.passed, false);
  assert.match(missing.reason, /missing/);
});

test('feature evidence locates actual fireplace and outdoor rooms; named rooms do not prove features', () => {
  const source = house(room({ name: 'Fireside terrace' }));
  for (const feature of ['fireplace', 'terrace', 'courtyard'])
    assert.equal(check(source, { kind: 'feature', feature }).passed, false);
  source.fireplace = { x: 0, z: 0, elevation: 0, height: 6 };
  assert.equal(check(source, { kind: 'feature', feature: 'fireplace', roomId: 'a' }).passed, true);
  assert.equal(
    check(source, { kind: 'feature', feature: 'fireplace', roomId: 'missing' }).passed,
    false,
  );
  source.fireplace.elevation = 3;
  assert.equal(check(source, { kind: 'feature', feature: 'fireplace' }).passed, false);
  source.rooms.push(room({ id: 'terrace', kind: 'terrace', x: 12 }));
  assert.equal(check(source, { kind: 'feature', feature: 'terrace' }).passed, true);
});

test('stair feature requires valid portals, full-width landings and floor levels, not just matching endpoints', () => {
  const source = house(room({ id: 'lower', z: -3 }), room({ id: 'upper', z: 3, elevation: 3 }));
  source.stairs = [{ id: 's', x: 0, z: 0, elevation: 0, rise: 3, width: 1, run: 4, rotation: 0 }];
  const assertion = { kind: 'feature', feature: 'linked_stair' };
  assert.equal(check(source, assertion).passed, false);
  source.design = {
    groups: [],
    connections: [],
    requirements: [],
    stairLinks: [{ stairId: 's', lowerRoomId: 'lower', upperRoomId: 'upper' }],
  };
  const blocked = check(source, assertion);
  assert.equal(blocked.passed, false);
  assert.ok(validateDesign(source).some((issue) => issue.code === 'stair_wall_blocked'));
  assert.deepEqual(
    (blocked.actual as { issues: unknown[] }).issues,
    validateDesign(source).filter(
      (issue) => issue.severity === 'error' && issue.objectIds.includes('s'),
    ),
  );
  source.rooms[0].south = 'open';
  source.rooms[0].height = 6;
  source.rooms[1].north = 'open';
  assert.equal(check(source, assertion).passed, true);
  assert.equal(check(source, { ...assertion, roomId: 'upper' }).passed, true);
  source.rooms[0].width = 1.5;
  source.stairs[0].width = 2;
  assert.equal(check(source, assertion).passed, false);
  assert.ok(
    inspectDesignQuality(source).features.stairLinkIssues.some(
      (issue) => issue.code === 'stair_landing_too_narrow',
    ),
  );
  source.rooms[0].width = 8;
  source.stairs[0].width = 1;
  source.stairs[0].rise = 2;
  assert.equal(check(source, assertion).passed, false);
});

test('default outdoor deck does not inherit the named house palette; explicit floor and room overrides are verifiable', () => {
  for (const kind of ['terrace', 'courtyard'] as const) {
    const source = house(room({ kind }));
    source.palette = 'charcoal';
    const assertion = {
      kind: 'material_composition',
      roomIds: ['a'],
      surfaces: ['floor'],
      allowedPalettes: ['charcoal'],
    };
    const evidence = inspectDesignQuality(source).rooms[0];
    assert.equal(evidence.floorPalette, null);
    assert.equal(evidence.floorPaletteSource, 'renderer-deck-default');
    const result = check(source, assertion);
    assert.equal(result.passed, false);
    assert.match(result.reason, /default deck/);
    source.rooms[0].palette = 'charcoal';
    assert.equal(check(source, assertion).passed, true);
    assert.equal(inspectDesignQuality(source).rooms[0].floorPaletteSource, 'room');
    source.rooms[0].surfacePalettes = { floor: 'cedar' };
    assert.equal(check(source, assertion).passed, false);
    assert.equal(check(source, { ...assertion, allowedPalettes: ['cedar'] }).passed, true);
    delete source.rooms[0].palette;
    assert.equal(check(source, { ...assertion, allowedPalettes: ['cedar'] }).passed, true);
    assert.equal(inspectDesignQuality(source).rooms[0].floorPaletteSource, 'surface');
  }
  const indoor = house(room());
  indoor.palette = 'charcoal';
  assert.equal(inspectDesignQuality(indoor).rooms[0].floorPalette, 'charcoal');
  assert.equal(inspectDesignQuality(indoor).rooms[0].floorPaletteSource, 'house');
});

test('quality schemas bound explicit commitments and inspection remains deterministic/read-only', () => {
  for (const value of [
    glazing([]),
    { ...glazing(), minCountPerRoom: 0 },
    { kind: 'material_composition', allowedPalettes: [] },
    { kind: 'room_program', roomKind: 'living', minCount: 0 },
    { kind: 'feature', feature: 'beautiful' },
  ])
    assert.equal(qualityAssertionSchema.safeParse(value).success, false);
  const source = house(room({ wallOpenings: [window()] })),
    before = structuredClone(source);
  assert.deepEqual(inspectDesignQuality(source), inspectDesignQuality(source));
  const assertion: QualityAssertion = qualityAssertionSchema.parse(glazing());
  evaluateQualityAssertion(source, assertion);
  assert.deepEqual(source, before);
});

test('stacked-volume evidence reports the full pavilion and distinguishes its covered lower flat roof', () => {
  const lower = room({ id: 'entry', height: 2.8, palette: 'limestone' });
  const upper = room({
    id: 'gallery',
    elevation: 2.8,
    height: 2.6,
    palette: 'cedar',
    roof: { style: 'pitched', pitch: 24, direction: 'east' },
  });
  const source = house(lower, upper);
  const evidence = inspectDesignQuality(source).stackedVolumes;
  assert.equal(evidence.length, 1);
  const stack = evidence[0];
  assert.deepEqual(stack.roomIds, ['entry', 'gallery']);
  assert.equal(stack.lowerBase.baseElevation, 0);
  assert.equal(stack.lowerBase.height, 2.8);
  assert.equal(stack.topWalls.eaveElevation, 5.4);
  assert.equal(stack.topVisibleRoof?.style, 'pitched');
  assert.equal(stack.totalHeight, 5.4 + 4 * Math.tan((24 * Math.PI) / 180));
  assert.equal(stack.topVisibleRoof?.maximumElevation, stack.totalHeight);
  assert.equal(stack.coveredLowerRoofs[0].style, 'flat');
  assert.equal(stack.coveredLowerRoofs[0].coveredByRoomId, 'gallery');
  assert.equal(stack.lowerBase.palettes.north, 'limestone');
  assert.equal(stack.topWalls.palettes.north, 'cedar');
});

test('stacked grouping excludes partial footprints, adjacent rooms, elevation gaps and nonflat lower roofs', () => {
  const lower = room({ id: 'lower', height: 3 });
  const upper = room({ id: 'upper', elevation: 3 });
  for (const patch of [
    { x: 0.001 },
    { width: 7.9 },
    { x: 8 },
    { elevation: 3.001 },
    { kind: 'terrace' as const },
  ]) {
    assert.deepEqual(
      inspectDesignQuality(house(lower, { ...upper, ...patch })).stackedVolumes,
      [],
      JSON.stringify(patch),
    );
  }
  assert.deepEqual(
    inspectDesignQuality(house({ ...lower, roof: { style: 'pitched', pitch: 20 } }, upper))
      .stackedVolumes,
    [],
  );
  assert.deepEqual(
    inspectDesignQuality(house(lower, room({ id: 'neighbor', x: 8 }))).stackedVolumes,
    [],
  );
});

test('stacked evidence uses directional roof profiles and qualifies higher partial coverage', () => {
  for (const direction of ['north', 'south', 'east', 'west'] as const) {
    const lower = room({ id: 'lower', elevation: 4, height: 3 });
    const upper = room({
      id: 'upper',
      elevation: 7,
      height: 3,
      roof: { style: 'single-pitch', pitch: 20, direction },
    });
    const source = house(lower, upper);
    const stack = inspectDesignQuality(source).stackedVolumes[0];
    const span = direction === 'east' || direction === 'west' ? 8 : 6;
    assert.equal(stack.totalHeight, 6 + span * Math.tan((20 * Math.PI) / 180));
    const qualified = inspectDesignQuality(
      house(lower, upper, room({ id: 'higher', elevation: 15, width: 4 })),
    ).stackedVolumes[0];
    assert.equal(qualified.topVisibleRoof, null);
    assert.deepEqual(qualified.higherOverlappingRoomIds, ['higher']);
    assert.equal(qualified.topRoof.maximumElevation, stack.topRoof.maximumElevation);
  }
});

test('stacked architectural evidence does not validate or repair an illegal stair link', () => {
  const source = house(room({ id: 'lower' }), room({ id: 'upper', elevation: 3 }));
  source.stairs = [
    { id: 'bad-stair', x: 20, z: 0, elevation: 0, rise: 3, width: 1.2, run: 4, rotation: 0 },
  ];
  source.design = {
    groups: [],
    connections: [],
    requirements: [],
    stairLinks: [{ stairId: 'bad-stair', lowerRoomId: 'lower', upperRoomId: 'upper' }],
  };
  const before = structuredClone(source);
  const errors = validateDesign(source).filter((issue) => issue.severity === 'error');
  assert.ok(errors.length > 0);
  const quality = inspectDesignQuality(source);
  assert.equal(quality.stackedVolumes.length, 1);
  assert.equal(quality.features.verifiedStairLinks.length, 0);
  assert.ok(quality.features.stairLinkIssues.length > 0);
  assert.deepEqual(
    validateDesign(source).filter((issue) => issue.severity === 'error'),
    errors,
  );
  assert.deepEqual(source, before);
});

test('stacked evidence supports unambiguous multilevel chains without merging duplicate branches', () => {
  const lower = room({ id: 'lower' });
  const middle = room({ id: 'middle', elevation: 3 });
  const upper = room({ id: 'upper', elevation: 6 });
  assert.deepEqual(
    inspectDesignQuality(house(lower, middle, upper)).stackedVolumes.map((stack) => stack.roomIds),
    [['lower', 'middle', 'upper']],
  );
  assert.deepEqual(
    inspectDesignQuality(house(lower, middle, { ...middle, id: 'duplicate' })).stackedVolumes,
    [],
  );
});

test('renderer-tolerated near-eave roof clipping qualifies the nominal stacked roof profile', () => {
  const lower = room({ id: 'lower', height: 3 });
  const upper = room({
    id: 'upper',
    elevation: 3,
    height: 3,
    roof: { style: 'pitched', pitch: 24, direction: 'east' },
  });
  const partial = room({ id: 'partial', elevation: 5.99, width: 4, depth: 4 });
  const source = house(lower, upper, partial);
  assert.deepEqual(
    validateDesign(source).filter((issue) => issue.severity === 'error'),
    [],
  );
  assert.equal(roomSlabs(source, upper).roofClipped, true);
  const stack = inspectDesignQuality(source).stackedVolumes[0];
  assert.equal(stack.roofClipped, true);
  assert.equal(stack.topVisibleRoof, null);
  assert.equal(stack.totalHeight, 6);
  assert.equal(stack.topRoof.maximumElevation, 6 + 4 * Math.tan((24 * Math.PI) / 180));
  assert.match(stack.topRoof.profileBasis, /nominal unclipped/);
  assert.deepEqual(stack.higherOverlappingRoomIds, ['partial']);
  assert.match(stack.roofVisibility, /renderer clips/);
});

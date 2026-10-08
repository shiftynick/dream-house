import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDesignReport,
  materialSummaryCsv,
  reportFilename,
  roomScheduleCsv,
} from '../shared/design-report.ts';
import { emptyScene, makeRoom, type Scene } from '../shared/model.ts';
import { executeCommands } from '../shared/design.ts';
import { floorPlanSheetSvg, designReportPrintHtml } from '../src/designReportSheets.ts';

const fixture = (): Scene => ({
  ...structuredClone(emptyScene),
  name: 'Courtyard home',
  rooms: [
    makeRoom({
      id: 'upper',
      name: 'Bedroom',
      elevation: 3,
      width: 4,
      depth: 5,
      palette: 'cedar',
      surfacePalettes: { north: 'charcoal' },
    }),
    makeRoom({ id: 'deck', name: 'Terrace', kind: 'terrace', x: 20, width: 2, depth: 3 }),
    makeRoom({ id: 'living', name: 'Living', width: 6, depth: 6 }),
  ],
});

test('report elevations, modeled areas and inherited materials are deterministic and nonmutating', () => {
  const scene = fixture(),
    original = structuredClone(scene);
  const report = buildDesignReport(scene);
  assert.deepEqual(report.levels, [0, 3]);
  assert.deepEqual(
    report.schedule.map((room) => room.name),
    ['Living', 'Terrace', 'Bedroom'],
  );
  assert.equal(report.indoorArea, 56);
  assert.equal(report.outdoorArea, 6);
  assert.equal(report.materials.length, 13);
  assert.deepEqual(
    report.materials.filter((entry) => entry.roomId === 'deck').map((entry) => entry.surface),
    ['floor'],
  );
  assert.deepEqual(
    report.materials.find((entry) => entry.roomId === 'upper' && entry.surface === 'north'),
    {
      roomId: 'upper',
      room: 'Bedroom',
      elevation: 3,
      surface: 'north',
      palette: 'charcoal',
      paletteName: 'Charcoal',
      source: 'Surface override',
      roof: '',
    },
  );
  assert.equal(
    report.materials.find((entry) => entry.roomId === 'upper' && entry.surface === 'floor')?.source,
    'Room palette',
  );
  assert.equal(
    report.materials.find((entry) => entry.roomId === 'living' && entry.surface === 'roof')?.source,
    'House default',
  );
  assert.deepEqual(scene, original);
  scene.rooms.reverse();
  assert.deepEqual(buildDesignReport(scene), report);
});

test('CSV preserves quoted Unicode names and units while blocking formula interpretation', () => {
  const scene = fixture();
  scene.rooms[0].name = '=HYPERLINK("evil")';
  scene.rooms[1].name = 'Deck, "south"\nCafé';
  const report = buildDesignReport(scene);
  const areas = roomScheduleCsv(report),
    materials = materialSummaryCsv(report);
  assert.ok(areas.startsWith('\uFEFF'));
  assert.match(areas, /"Modeled rectangle area \(m²\)"/);
  assert.ok(areas.includes('"\'=HYPERLINK(""evil"")"'));
  assert.ok(areas.includes('"Deck, ""south""\nCafé"'));
  assert.match(areas, /not surveyed, buildable or net usable/);
  assert.match(materials, /"Inheritance"/);
  assert.match(materials, /"Surface override"/);
});

test('standalone sheet escapes markup, isolates elevation and records scale and room dimensions', () => {
  const scene = fixture();
  scene.name = '<script>alert("house")</script>';
  scene.rooms[2].name = 'Living <img onerror="bad"> & dining';
  const svg = floorPlanSheetSvg(scene, 0);
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.match(svg, /&lt;script&gt;/);
  assert.match(svg, /Living &lt;img onerror=&quot;bad&quot;&gt; &amp; dining/);
  assert.doesNotMatch(svg, /<script>|<img/);
  assert.doesNotMatch(svg, /Bedroom/);
  assert.match(svg, /6 × 6 m · 36 m²/);
  assert.match(svg, /m reference · use the bar when resizing/);
  assert.match(svg, /not construction documents/);
  const html = designReportPrintHtml(scene);
  assert.doesNotMatch(html, /<script>|<img/);
  assert.match(html, /@page\{size:A4 landscape/);
  assert.match(html, /Room area schedule/);
  assert.match(html, /Effective material summary/);
  assert.equal((html.match(/<svg /g) ?? []).length, 2);
});

test('windows use wall-local offsets and sheets preserve explicit, legacy and mirrored passages', () => {
  const scene: Scene = {
    ...emptyScene,
    rooms: [
      makeRoom({
        id: 'room',
        height: 2.8,
        width: 6,
        depth: 6,
        south: 'glass',
        east: 'door',
        wallOpenings: [
          { id: 'w', side: 'north', offset: 1, width: 2, height: 1, sill: 1.5, kind: 'window' },
        ],
      }),
    ],
  };
  const svg = floorPlanSheetSvg(scene, 0);
  // World north z=-3 maps to y=105; offset +1 spans x=0..2.
  assert.match(svg, /<line x1="560" y1="105" x2="736\.67" y2="105" stroke="#3f7c9a"/);
  assert.match(svg, /window · 6 × 2\.8 m/);
  assert.match(svg, /door · 1\.3 × 2\.4 m/);
  const connected = executeCommands(
    {
      ...emptyScene,
      rooms: [
        makeRoom({ id: 'a', width: 6, depth: 6 }),
        makeRoom({ id: 'b', x: 6, width: 6, depth: 6 }),
      ],
    },
    [{ type: 'connect_rooms', roomAId: 'a', roomBId: 'b', width: 1.5 }],
  ).scene;
  assert.equal(
    (floorPlanSheetSvg(connected, 0).match(/door · 1\.5 × 2\.4 m/g) ?? []).length,
    2,
    'same semantic passage is marked on both room faces',
  );
});

test('stairs appear on both modeled landing levels, with consistent yaw and outside-room bounds', () => {
  const scene = fixture();
  scene.stairs = [
    { id: 'stair', x: -10, z: 0, elevation: 0, rise: 3, run: 4, width: 1, rotation: 90 },
  ];
  for (const elevation of [0, 3]) {
    const svg = floorPlanSheetSvg(scene, elevation);
    assert.match(svg, /Stair · 1 m wide · 3 m rise/);
    assert.match(svg, /rotate\(-90\)/);
    assert.doesNotMatch(svg, /NaN|Infinity/);
  }
  assert.doesNotMatch(floorPlanSheetSvg(scene, 8), /Stair ·/);
});

test('empty projects produce usable empty schedules and safe bounded download names', () => {
  const report = buildDesignReport(emptyScene);
  assert.deepEqual(report.levels, []);
  assert.equal(report.indoorArea, 0);
  assert.equal(report.outdoorArea, 0);
  assert.match(roomScheduleCsv(report), /Area definition/);
  assert.equal(reportFilename(' ../Café / House <bad> '), 'cafe-house-bad');
  assert.equal(reportFilename('...'), 'terrain-house');
  assert.ok(reportFilename('x'.repeat(200)).length <= 70);
  assert.doesNotMatch(designReportPrintHtml(emptyScene), /NaN|Infinity|undefined/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { BoxGeometry, type BufferGeometry } from 'three';
import { emptyScene, makeRoom, type Room, type Scene, type Side } from '../shared/model';
import { effectiveRoof, roofHeightAt } from '../shared/architecture';
import { roofPatches, wallAxis, wallTopProfile } from '../src/renderGeometry';
import { physicalUvs, slabGeometry, wallCapGeometry } from '../src/renderMeshes';
import { wallSurfaceGeometry } from '../src/architecturalFinish';

function roofGeometry(scene: Scene, room: Room) {
  const roof = effectiveRoof(scene, room);
  const axis = roof.style === 'flat' || ['north', 'south'].includes(roof.direction) ? 'z' : 'x';
  return roofPatches(scene, room).map((rect) =>
    slabGeometry(
      rect,
      [room.x, room.elevation, room.z],
      (x, z) => roofHeightAt(scene, room, x, z) + 0.18,
      (x, z) => roofHeightAt(scene, room, x, z),
      axis,
    ),
  );
}

type Sample = { world: number[]; uv: number[] };
function sharedSamples(a: Sample[], b: Sample[]) {
  let matches = 0;
  for (const sample of a) {
    const other = b.find((candidate) =>
      candidate.world.every((value, axis) => Math.abs(value - sample.world[axis]) < 0.00001),
    );
    if (!other) continue;
    matches++;
    for (let axis = 0; axis < 2; axis++)
      assert.ok(Math.abs(sample.uv[axis] - other.uv[axis]) < 0.00001, 'shared point has one UV');
  }
  assert.ok(matches >= 2, 'the fixture must contain a shared edge');
}

test('box projection never collapses both UV axes on a steep east/west face', () => {
  for (const angle of [44, 46, 55, 60]) {
    const geometry = new BoxGeometry(4, 0.18, 5).toNonIndexed();
    geometry.rotateZ((angle * Math.PI) / 180);
    physicalUvs(geometry);
    const uv = geometry.getAttribute('uv');
    for (let i = 0; i < uv.count; i += 3) {
      const area =
        (uv.getX(i + 1) - uv.getX(i)) * (uv.getY(i + 2) - uv.getY(i)) -
        (uv.getY(i + 1) - uv.getY(i)) * (uv.getX(i + 2) - uv.getX(i));
      assert.ok(Math.abs(area) > 0.00001, `${angle}° triangle has usable UV area`);
    }
    geometry.dispose();
  }
});

test('roof faces keep physical texture scale and downhill grain for every supported slope axis', () => {
  for (const style of ['pitched', 'single-pitch'] as const)
    for (const direction of ['north', 'south', 'east', 'west'] as const)
      for (const pitch of [1, 20, 44, 46, 55, 60]) {
        const room = makeRoom({
          id: 'roof',
          x: 2.3,
          z: -1.7,
          elevation: 0.4,
          width: 5,
          depth: 4,
          roof: { style, direction, pitch },
        });
        for (const geometry of roofGeometry({ ...emptyScene, rooms: [room] }, room)) {
          const p = geometry.getAttribute('position'),
            uv = geometry.getAttribute('uv');
          // Closed slab ordering: first six vertices bottom, next six top.
          for (const start of [0, 3, 6, 9])
            for (const [a, b] of [
              [start, start + 1],
              [start + 1, start + 2],
              [start + 2, start],
            ]) {
              const distance = Math.hypot(
                p.getX(a) - p.getX(b),
                p.getY(a) - p.getY(b),
                p.getZ(a) - p.getZ(b),
              );
              const uvDistance = Math.hypot(uv.getX(a) - uv.getX(b), uv.getY(a) - uv.getY(b));
              assert.ok(
                Math.abs(distance - uvDistance) < 0.00002,
                `${style} ${direction} ${pitch}° retains meters`,
              );
              const acrossDifference = ['north', 'south'].includes(direction)
                ? p.getX(a) - p.getX(b)
                : p.getZ(a) - p.getZ(b);
              assert.ok(
                Math.abs(uv.getX(a) - uv.getX(b) - acrossDifference) < 0.00001,
                'board width runs across slope',
              );
            }
          geometry.dispose();
        }
      }
});

test('unequal adjoining roof rooms share UV phase across flat and sloped panels', () => {
  for (const direction of ['north', 'south', 'east', 'west'] as const)
    for (const style of ['flat', 'single-pitch', 'pitched'] as const) {
      const acrossX = ['north', 'south'].includes(direction);
      const rooms = [
        makeRoom({
          id: 'a',
          x: acrossX ? -2 : 1.3,
          z: acrossX ? 1.3 : -2,
          width: acrossX ? 4 : 6,
          depth: acrossX ? 6 : 4,
        }),
        makeRoom({
          id: 'b',
          x: acrossX ? 2.5 : 1.3,
          z: acrossX ? 1.3 : 2.5,
          width: acrossX ? 5 : 6,
          depth: acrossX ? 6 : 5,
        }),
      ];
      const scene: Scene = {
        ...emptyScene,
        roof: style,
        roofDirection: direction,
        roofPitch: 55,
        rooms,
      };
      const samples = rooms.map((room) => {
        const result: Sample[] = [];
        for (const geometry of roofGeometry(scene, room)) {
          const p = geometry.getAttribute('position'),
            uv = geometry.getAttribute('uv');
          for (let i = 6; i < 12; i++)
            result.push({
              world: [p.getX(i) + room.x, p.getY(i) + room.elevation, p.getZ(i) + room.z],
              uv: [uv.getX(i), uv.getY(i)],
            });
          geometry.dispose();
        }
        return result;
      });
      sharedSamples(samples[0], samples[1]);
    }
});

function wallSamples(geometry: BufferGeometry, room: Room, side: Side) {
  const p = geometry.getAttribute('position'),
    n = geometry.getAttribute('normal'),
    uv = geometry.getAttribute('uv');
  const result: Sample[] = [];
  for (let i = 0; i < p.count; i++) {
    if (n.getZ(i) < 0.99) continue;
    result.push({
      world: [p.getX(i) + wallAxis(room, side).center, p.getY(i) + room.elevation],
      uv: [uv.getX(i), uv.getY(i)],
    });
  }
  return result;
}

test('adjoining wall bodies, opening fragments and roof caps share architectural UV coordinates', () => {
  for (const side of ['north', 'south', 'east', 'west'] as const) {
    const horizontal = ['north', 'south'].includes(side);
    const rooms = [
      makeRoom({
        id: 'a',
        x: horizontal ? -2 : 0,
        z: horizontal ? 0 : -2,
        width: horizontal ? 4 : 6,
        depth: horizontal ? 6 : 4,
      }),
      makeRoom({
        id: 'b',
        x: horizontal ? 2.5 : 0,
        z: horizontal ? 0 : 2.5,
        width: horizontal ? 5 : 6,
        depth: horizontal ? 6 : 5,
      }),
    ].map(
      (room) =>
        ({
          ...room,
          elevation: 0.35,
          north: 'solid',
          south: 'solid',
          east: 'solid',
          west: 'solid',
          wallOpenings: [
            {
              id: `${room.id}-window`,
              side,
              kind: 'window',
              offset: 0,
              width: 1,
              height: 1,
              sill: 1,
            },
          ],
        }) as Room,
    );
    const scene: Scene = {
      ...emptyScene,
      roof: 'single-pitch',
      roofDirection: side,
      roofPitch: 20,
      rooms,
    };
    const samples = rooms.map((room) => {
      const parts = wallSurfaceGeometry(scene, room, side);
      const body = parts.find((part) => part.material === 'wall')!.geometry;
      const cap = wallCapGeometry(
        wallTopProfile(scene, room, side),
        room.height,
        [],
        [wallAxis(room, side).center, room.elevation, 0],
      )!;
      const bodySamples = wallSamples(body, room, side),
        capSamples = wallSamples(cap, room, side);
      sharedSamples(bodySamples, capSamples);
      // Every opening fragment uses the same mapping as the unbroken face.
      for (const sample of bodySamples)
        for (let axis = 0; axis < 2; axis++)
          assert.ok(Math.abs(sample.world[axis] - sample.uv[axis]) < 0.00001);
      const result = [...bodySamples, ...capSamples];
      parts.forEach((part) => part.geometry.dispose());
      cap.dispose();
      return result;
    });
    sharedSamples(samples[0], samples[1]);
  }
});

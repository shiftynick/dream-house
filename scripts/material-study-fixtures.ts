import { emptyScene, makeRoom, sceneSchema, type Scene } from '../shared/model.ts';
import { renderRequestSchema, type RenderCamera } from '../shared/render.ts';

/** Unequal room widths make texture phase resets visible; no saved house data. */
export function materialStudyCaptures() {
  const base: Scene = {
    ...structuredClone(emptyScene),
    name: 'Adjoining material study',
    palette: 'cedar',
    slope: 0,
    rooms: [
      makeRoom({ id: 'left', name: 'Left', x: -1.7, width: 3.4, depth: 4.2 }),
      makeRoom({ id: 'right', name: 'Right', x: 2.3, width: 4.6, depth: 4.2 }),
    ].map((room) => ({
      ...room,
      height: 2.8,
      north: 'solid',
      south: 'solid',
      east: 'solid',
      west: 'solid',
      furniture: [],
      wallOpenings: [
        {
          id: `${room.id}-window`,
          side: 'south',
          kind: 'window',
          offset: 0,
          width: 1,
          height: 1,
          sill: 1,
        },
      ],
    })),
  };
  const task = (name: string, scene: Scene, camera: RenderCamera) => ({
    filename: `${name}.png`,
    scene: sceneSchema.parse(scene),
    request: renderRequestSchema.parse({ view: 'exterior', quality: 'live', light: 'day', camera }),
  });
  const tasks = [
    task('flat-roof-join', base, { position: [5, 10, 13], target: [0.6, 2, 0] }),
    task('wall-join', base, { position: [0.2, 3.4, 10.5], target: [0.2, 1.65, 2.05] }),
  ];
  const mono = structuredClone(base);
  mono.roof = 'single-pitch';
  mono.roofPitch = 20;
  mono.roofDirection = 'north';
  tasks.push(task('single-pitch-join', mono, { position: [5, 10, 13], target: [0.6, 3, 0] }));
  for (const [direction, pitch] of [
    ['east', 46],
    ['west', 55],
  ] as const) {
    const steep = structuredClone(base);
    steep.roof = 'single-pitch';
    steep.roofPitch = pitch;
    steep.roofDirection = direction;
    // Rooms join along the ridge direction so both roofs lie in one plane.
    steep.rooms = steep.rooms.map((room, index) => ({
      ...room,
      x: 0,
      z: index === 0 ? -1.7 : 2.3,
      width: 3.4,
      depth: index === 0 ? 3.4 : 4.6,
      wallOpenings: [],
    }));
    tasks.push(
      task(`steep-${direction}-${pitch}`, steep, {
        position: [direction === 'east' ? -12 : 12, 11, 13],
        target: [0, 3.8, 0.6],
      }),
    );
  }
  return tasks;
}

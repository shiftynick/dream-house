import { z } from 'zod';
import { emptyScene, type Scene, type Room } from './model';
import { effectiveRoof, roofMaximumHeight } from './architecture';
import { stairPlanFootprint } from './spatial';

const coordinate = z.number().finite().min(-500).max(500);
export const renderCameraSchema = z
  .object({
    position: z.tuple([coordinate, coordinate, coordinate]),
    target: z.tuple([coordinate, coordinate, coordinate]),
  })
  .strict()
  .refine(
    (camera) =>
      Math.hypot(...camera.position.map((value, index) => value - camera.target[index])) > 0.001,
    'Camera position and target must differ.',
  );
export const renderRequestSchema = z
  .object({
    view: z.enum(['exterior', 'interior', 'cutaway', 'plan']),
    roomId: z.string().min(1).max(60).optional(),
    elevation: z.number().min(-10).max(20).optional(),
    angle: z.enum(['southeast', 'southwest', 'northeast', 'northwest']).default('southeast'),
    quality: z.enum(['live', 'clay', 'wireframe']).default('live'),
    light: z.enum(['day', 'golden', 'evening']).default('day'),
    camera: renderCameraSchema.optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.view === 'interior' && !request.roomId)
      context.addIssue({
        code: 'custom',
        path: ['roomId'],
        message: 'An interior render requires a roomId.',
      });
  });
export type RenderRequest = z.infer<typeof renderRequestSchema>;
export type RenderJob = { id: string; scene: Scene; sceneHash: string; request: RenderRequest };
export type RenderCamera = { position: [number, number, number]; target: [number, number, number] };
export type RenderCaptureResult = {
  image: string;
  width: number;
  height: number;
  camera: RenderCamera;
  sceneHash: string;
  view: RenderRequest['view'];
};

export function renderFloor(scene: Scene, request: RenderRequest): number {
  const room = request.roomId ? scene.rooms.find((item) => item.id === request.roomId) : undefined;
  if (request.roomId && !room) throw new Error('The requested render room no longer exists.');
  const floor =
    request.elevation ??
    room?.elevation ??
    (scene.rooms.length ? Math.min(...scene.rooms.map((item) => item.elevation)) : 0);
  if (scene.rooms.length && !scene.rooms.some((item) => Math.abs(item.elevation - floor) < 0.01))
    throw new Error(`There is no floor at ${floor} m to render.`);
  return floor;
}

/** Deterministic framing is independent of the user's current viewport. */
export function renderCamera(
  scene: Scene,
  request: RenderRequest,
  aspect = 4 / 3,
): RenderCamera & { fov: number } {
  if (!Number.isFinite(aspect) || aspect <= 0)
    throw new Error('The render aspect ratio must be positive.');
  const focus = request.roomId ? scene.rooms.find((room) => room.id === request.roomId) : undefined;
  if (request.roomId && !focus) throw new Error('The requested render room no longer exists.');
  const east = request.angle.endsWith('east') ? 1 : -1;
  const south = request.angle.startsWith('south') ? 1 : -1;
  if (request.view === 'interior') {
    if (!focus) throw new Error('An interior render requires a roomId.');
    if (['terrace', 'courtyard'].includes(focus.kind))
      throw new Error('An interior render requires an enclosed room.');
    const eye = focus.elevation + Math.min(1.6, focus.height * 0.6);
    return {
      position: [focus.x + east * focus.width * 0.34, eye, focus.z + south * focus.depth * 0.34],
      target: [focus.x - east * focus.width * 0.16, eye, focus.z - south * focus.depth * 0.16],
      fov: 68,
    };
  }
  if (request.view === 'plan') {
    const elevation = renderFloor(scene, request);
    const rooms = scene.rooms.filter((room) => Math.abs(room.elevation - elevation) < 0.01);
    const center = rooms.length
      ? [
          (Math.min(...rooms.map((room) => room.x - room.width / 2)) +
            Math.max(...rooms.map((room) => room.x + room.width / 2))) /
            2,
          (Math.min(...rooms.map((room) => room.z - room.depth / 2)) +
            Math.max(...rooms.map((room) => room.z + room.depth / 2))) /
            2,
        ]
      : [0, 0];
    return {
      position: [center[0], elevation + 50, center[1]],
      target: [center[0], elevation, center[1]],
      fov: 43,
    };
  }
  if (request.camera)
    return { position: [...request.camera.position], target: [...request.camera.target], fov: 43 };
  const rooms = focus ? [focus] : scene.rooms;
  const extents = rooms.length
    ? rooms.reduce(
        (value, room) => [
          Math.min(value[0], room.x - room.width / 2 - 0.5),
          Math.min(value[1], room.elevation - 0.7),
          Math.min(value[2], room.z - room.depth / 2 - 0.5),
          Math.max(value[3], room.x + room.width / 2 + 0.5),
          Math.max(value[4], roofMaximumHeight(scene, room) + 0.8),
          Math.max(value[5], room.z + room.depth / 2 + 0.5),
        ],
        [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity],
      )
    : [-11, -1, -9, 11, 2, 9];
  if (!focus) {
    for (const stair of scene.stairs) {
      const footprint = stairPlanFootprint(stair);
      extents[0] = Math.min(extents[0], footprint.minX);
      extents[1] = Math.min(extents[1], stair.elevation);
      extents[2] = Math.min(extents[2], footprint.minZ);
      extents[3] = Math.max(extents[3], footprint.maxX);
      extents[4] = Math.max(extents[4], stair.elevation + stair.rise);
      extents[5] = Math.max(extents[5], footprint.maxZ);
    }
    if (scene.fireplace) {
      const fire = scene.fireplace;
      extents[0] = Math.min(extents[0], fire.x - 1.2);
      extents[1] = Math.min(extents[1], fire.elevation);
      extents[2] = Math.min(extents[2], fire.z - 0.8);
      extents[3] = Math.max(extents[3], fire.x + 1.2);
      extents[4] = Math.max(extents[4], fire.elevation + fire.height);
      extents[5] = Math.max(extents[5], fire.z + 0.8);
    }
  }
  const target: [number, number, number] = [
    (extents[0] + extents[3]) / 2,
    (extents[1] + extents[4]) / 2,
    (extents[2] + extents[5]) / 2,
  ];
  const radius =
    Math.hypot(extents[3] - extents[0], extents[4] - extents[1], extents[5] - extents[2]) / 2;
  const fov = 43;
  const halfFov = Math.min(
    (fov * Math.PI) / 360,
    Math.atan(Math.tan((fov * Math.PI) / 360) * aspect),
  );
  const distance = Math.max(8, (radius / Math.sin(halfFov)) * 1.12);
  const direction = [east * 0.66, 0.58, south * 0.66];
  const scale = distance / Math.hypot(...direction);
  return {
    position: [
      target[0] + direction[0] * scale,
      target[1] + direction[1] * scale,
      target[2] + direction[2] * scale,
    ],
    target,
    fov,
  };
}

/** Frame every alternative with one camera, including its full roof and chimney. */
export function renderCameraForScenes(
  scenes: Scene[],
  request: RenderRequest,
  aspect = 4 / 3,
): RenderCamera & { fov: number } {
  if (!['exterior', 'cutaway'].includes(request.view))
    throw new Error('A shared comparison camera requires an exterior or cutaway view.');
  const roomBounds = scenes
    .flatMap((scene) => scene.rooms.map((room) => ({ ...room, roof: effectiveRoof(scene, room) })))
    .filter((room) => !request.roomId || room.id === request.roomId);
  if (request.roomId && !roomBounds.length)
    throw new Error('The requested comparison room does not exist.');
  const chimneyBounds: Room[] = request.roomId
    ? []
    : scenes.flatMap((scene, index) =>
        scene.fireplace
          ? [
              {
                id: `render-bound-chimney-${index}`,
                name: 'Chimney bounds',
                roof: { style: 'flat' as const },
                kind: 'other' as const,
                x: scene.fireplace.x,
                z: scene.fireplace.z,
                elevation: scene.fireplace.elevation,
                width: 2.4,
                depth: 1.6,
                height: scene.fireplace.height,
                north: 'open' as const,
                south: 'open' as const,
                east: 'open' as const,
                west: 'open' as const,
              },
            ]
          : [],
      );
  // This synthetic scene is only a bounds carrier; it is never rendered, saved,
  // or passed to model tools. Its overlapping/duplicate-ID alternatives are intentional.
  const aggregate: Scene = {
    ...emptyScene,
    rooms: [...roomBounds, ...chimneyBounds],
    stairs: request.roomId ? [] : scenes.flatMap((scene) => scene.stairs),
    roof: scenes.some((scene) => scene.roof === 'pitched') ? 'pitched' : 'flat',
  };
  return renderCamera(aggregate, { ...request, roomId: undefined }, aspect);
}

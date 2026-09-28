import { z } from 'zod';

export const wallSchema = z.enum(['solid', 'glass', 'door', 'open']);
export const sideSchema = z.enum(['north', 'south', 'east', 'west']);
export const paletteSchema = z.enum(['limestone', 'cedar', 'charcoal', 'chalk']);
export const surfaceSchema = z.enum(['north', 'south', 'east', 'west', 'floor', 'roof']);
export const surfacePalettesSchema = z.object({
  north: paletteSchema.optional(),
  south: paletteSchema.optional(),
  east: paletteSchema.optional(),
  west: paletteSchema.optional(),
  floor: paletteSchema.optional(),
  roof: paletteSchema.optional(),
});
export type Surface = z.infer<typeof surfaceSchema>;
export type Side = z.infer<typeof sideSchema>;
export const roomSchema = z.object({
  id: z.string().min(1).max(60),
  name: z.string().min(1).max(80),
  kind: z.enum([
    'living',
    'kitchen',
    'bedroom',
    'bathroom',
    'hall',
    'courtyard',
    'terrace',
    'other',
  ]),
  x: z.number().min(-60).max(60),
  z: z.number().min(-60).max(60),
  elevation: z.number().min(-10).max(20),
  width: z.number().min(1.5).max(30),
  depth: z.number().min(1.5).max(30),
  height: z.number().min(2.2).max(10),
  north: wallSchema,
  south: wallSchema,
  east: wallSchema,
  west: wallSchema,
  palette: paletteSchema.optional(),
  surfacePalettes: surfacePalettesSchema.optional(),
});
export const stairSchema = z.object({
  id: z.string().min(1).max(60),
  x: z.number().min(-60).max(60),
  z: z.number().min(-60).max(60),
  elevation: z.number().min(-10).max(20),
  rise: z.number().min(0.3).max(6),
  width: z.number().min(0.8).max(4),
  run: z.number().min(1).max(12),
  rotation: z.number().min(-360).max(360),
});
const idSchema = z.string().min(1).max(60);
export const groupSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(80),
  roomIds: z.array(idSchema).min(1).max(32),
});
export const connectionSchema = z.object({
  id: idSchema,
  roomAId: idSchema,
  roomBId: idSchema,
  sideA: sideSchema,
  // World x for a north/south wall; world z for an east/west wall.
  center: z.number().min(-90).max(90),
  width: z.number().min(0.8).max(30),
  height: z.number().min(2).max(10),
  kind: z.enum(['door', 'open']),
});
export const stairLinkSchema = z.object({
  stairId: idSchema,
  lowerRoomId: idSchema,
  upperRoomId: idSchema,
});
const requirementBase = {
  id: idSchema,
  description: z.string().min(1).max(500),
  source: z.enum(['confirmed', 'assumption', 'preference']),
};
export const lockSnapshotSchema = z.object({
  x: z.number(),
  z: z.number(),
  elevation: z.number(),
  width: z.number(),
  depth: z.number(),
  height: z.number(),
  palette: paletteSchema,
  surfacePalettes: surfacePalettesSchema.optional(),
});
export const requirementSchema = z.discriminatedUnion('kind', [
  z.object({
    ...requirementBase,
    kind: z.literal('connectivity'),
    roomIds: z.array(idSchema).min(1).max(32),
    targetRoomId: idSchema,
    indoorOnly: z.boolean(),
  }),
  z.object({
    ...requirementBase,
    kind: z.literal('symmetry'),
    pairs: z
      .array(z.object({ roomAId: idSchema, roomBId: idSchema }))
      .min(1)
      .max(16),
    axis: z.enum(['x', 'z']),
    center: z.number().min(-60).max(60),
  }),
  z.object({
    ...requirementBase,
    kind: z.literal('locked'),
    roomId: idSchema,
    properties: z
      .array(z.enum(['position', 'size', 'height', 'material']))
      .min(1)
      .max(4),
    snapshot: lockSnapshotSchema.optional(),
  }),
  z.object({
    ...requirementBase,
    kind: z.literal('overlook'),
    upperRoomId: idSchema,
    lowerRoomId: idSchema,
  }),
  z.object({ ...requirementBase, kind: z.literal('intent') }),
]);
export const designSchema = z.object({
  groups: z.array(groupSchema).max(32),
  connections: z.array(connectionSchema).max(96),
  stairLinks: z.array(stairLinkSchema).max(12),
  requirements: z.array(requirementSchema).max(60),
});
export type RoomGroup = z.infer<typeof groupSchema>;
export type Connection = z.infer<typeof connectionSchema>;
export type DesignRequirement = z.infer<typeof requirementSchema>;
export type DesignMetadata = z.infer<typeof designSchema>;
export const sceneSchema = z.object({
  name: z.string().min(1).max(100),
  palette: paletteSchema,
  roof: z.enum(['flat', 'pitched']),
  slope: z.number().min(0).max(0.35),
  rooms: z.array(roomSchema).max(32),
  stairs: z.array(stairSchema).max(12),
  fireplace: z
    .object({
      x: z.number().min(-60).max(60),
      z: z.number().min(-60).max(60),
      elevation: z.number().min(-10).max(20),
      height: z.number().min(2).max(16),
    })
    .nullable(),
  design: designSchema.optional(),
});
export type Scene = z.infer<typeof sceneSchema>;
export type Room = z.infer<typeof roomSchema>;
export type Stair = z.infer<typeof stairSchema>;
export type Palette = Scene['palette'];
export const messageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant']),
  text: z.string().max(10000),
  kind: z.enum(['error', 'status']).optional(),
  retryText: z.string().max(10000).optional(),
});
export type Message = z.infer<typeof messageSchema>;
export const documentSchema = z.object({
  version: z.literal(1),
  projectId: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,80}$/)
    .optional(),
  projectName: z.string().min(1).max(100).optional(),
  revision: z.number().int().nonnegative().default(0),
  scene: sceneSchema,
  past: z.array(sceneSchema).max(60),
  future: z.array(sceneSchema).max(60),
  variants: z
    .array(
      z.object({
        id: z.string(),
        name: z.string().min(1).max(80),
        createdAt: z.string(),
        scene: sceneSchema,
        thumbnail: z
          .string()
          .max(500_000)
          .regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/)
          .optional(),
        description: z.string().max(1000).optional(),
        source: z.enum(['saved', 'generated']).optional(),
        intent: z.string().max(2000).optional(),
      }),
    )
    .max(30),
  messages: z.array(messageSchema).max(100),
});
export type Project = z.infer<typeof documentSchema>;
export const agentResponseSchema = z.object({
  reply: z.string().min(1).max(1500),
  needsConfirmation: z.boolean(),
  scene: sceneSchema.nullable(),
});
export type AgentResponse = z.infer<typeof agentResponseSchema>;
export const emptyScene: Scene = {
  name: 'Untitled home',
  palette: 'limestone',
  roof: 'flat',
  slope: 0.12,
  rooms: [],
  stairs: [],
  fireplace: null,
};
export function newProject(): Project {
  return {
    version: 1,
    revision: 0,
    scene: structuredClone(emptyScene),
    past: [],
    future: [],
    variants: [],
    messages: [],
  };
}
export function editProject(project: Project, scene: Scene): Project {
  validateScene(scene);
  return { ...project, scene, past: [...project.past, project.scene].slice(-60), future: [] };
}
export function undo(project: Project): Project {
  if (!project.past.length) return project;
  return {
    ...project,
    scene: project.past.at(-1)!,
    past: project.past.slice(0, -1),
    future: [project.scene, ...project.future].slice(0, 60),
  };
}
export function redo(project: Project): Project {
  if (!project.future.length) return project;
  return {
    ...project,
    scene: project.future[0],
    past: [...project.past, project.scene].slice(-60),
    future: project.future.slice(1),
  };
}
export function validateScene(input: unknown): Scene {
  const scene = sceneSchema.parse(input);
  const ids = [...scene.rooms, ...scene.stairs].map((r) => r.id);
  if (new Set(ids).size !== ids.length) throw new Error('Each room and stair needs a unique ID.');
  const enclosed = scene.rooms.filter((r) => !['courtyard', 'terrace'].includes(r.kind));
  for (let i = 0; i < enclosed.length; i++)
    for (let j = i + 1; j < enclosed.length; j++) {
      const a = enclosed[i],
        b = enclosed[j];
      const overlapX = (a.width + b.width) / 2 - Math.abs(a.x - b.x);
      const overlapZ = (a.depth + b.depth) / 2 - Math.abs(a.z - b.z);
      const overlapY =
        Math.min(a.elevation + a.height, b.elevation + b.height) -
        Math.max(a.elevation, b.elevation);
      if (overlapX > 0.03 && overlapZ > 0.03 && overlapY > 0.03)
        throw new Error(
          `“${a.name}” and “${b.name}” overlap. Adjust their positions or dimensions before applying this design.`,
        );
    }
  return scene;
}
export function area(scene: Scene) {
  return scene.rooms
    .filter((r) => !['courtyard', 'terrace'].includes(r.kind))
    .reduce((n, r) => n + r.width * r.depth, 0);
}
export function makeRoom(overrides: Partial<Room> = {}): Room {
  return {
    id: crypto.randomUUID(),
    name: 'New room',
    kind: 'other',
    x: 0,
    z: 0,
    elevation: 0,
    width: 6,
    depth: 5,
    height: 3.2,
    north: 'solid',
    south: 'glass',
    east: 'door',
    west: 'solid',
    ...overrides,
  };
}
export const palettes: Record<
  Palette,
  {
    name: string;
    description: string;
    wall: string;
    wood: string;
    roof: string;
    floor: string;
    accent: string;
  }
> = {
  limestone: {
    name: 'Warm limestone',
    description: 'Quiet stone. Natural oak. Bronze.',
    wall: '#c9c0a9',
    wood: '#a87d50',
    roof: '#67675e',
    floor: '#c7b69a',
    accent: '#393c32',
  },
  cedar: {
    name: 'Woodland cedar',
    description: 'Warm timber. Forest tones.',
    wall: '#947052',
    wood: '#a07547',
    roof: '#444a42',
    floor: '#b39b7b',
    accent: '#29382e',
  },
  charcoal: {
    name: 'Dark & sculptural',
    description: 'Charred wood. Concrete. Black steel.',
    wall: '#444945',
    wood: '#806b52',
    roof: '#2c312e',
    floor: '#a6a59b',
    accent: '#242a27',
  },
  chalk: {
    name: 'Soft minimal',
    description: 'Chalk plaster. Pale oak. Light.',
    wall: '#e8e5dc',
    wood: '#baa588',
    roof: '#a7a69e',
    floor: '#d8cdb8',
    accent: '#757b70',
  },
};
export function sampleScene(): Scene {
  return {
    name: 'The hillside study',
    palette: 'limestone',
    roof: 'flat',
    slope: 0.16,
    rooms: [
      makeRoom({
        id: 'living',
        name: 'Double-height living',
        kind: 'living',
        x: 0,
        z: 2,
        width: 12,
        depth: 8,
        height: 6.4,
        north: 'open',
        south: 'glass',
        east: 'glass',
        west: 'glass',
      }),
      makeRoom({
        id: 'lower',
        name: 'Library',
        kind: 'other',
        x: 0,
        z: -5,
        width: 12,
        depth: 6,
        height: 3.2,
        south: 'open',
      }),
      makeRoom({
        id: 'kitchen',
        name: 'Kitchen & dining',
        kind: 'kitchen',
        x: 0,
        z: -5,
        elevation: 3.2,
        width: 12,
        depth: 6,
        height: 3.2,
        south: 'open',
        east: 'door',
        west: 'door',
      }),
      makeRoom({
        id: 'west-suite',
        name: 'West bedroom',
        kind: 'bedroom',
        x: -11,
        z: -4,
        elevation: 3.2,
        width: 6,
        depth: 6,
        east: 'door',
      }),
      makeRoom({
        id: 'east-suite',
        name: 'East bedroom',
        kind: 'bedroom',
        x: 11,
        z: -4,
        elevation: 3.2,
        width: 6,
        depth: 6,
        west: 'door',
      }),
      makeRoom({
        id: 'west-bath',
        name: 'West bath',
        kind: 'bathroom',
        x: -11,
        z: -8.5,
        elevation: 3.2,
        width: 6,
        depth: 3,
        north: 'solid',
        south: 'door',
      }),
      makeRoom({
        id: 'east-bath',
        name: 'East bath',
        kind: 'bathroom',
        x: 11,
        z: -8.5,
        elevation: 3.2,
        width: 6,
        depth: 3,
        north: 'solid',
        south: 'door',
      }),
      makeRoom({
        id: 'west-guest',
        name: 'West guest room',
        kind: 'bedroom',
        x: -12,
        z: 5,
        width: 6,
        depth: 6,
        east: 'glass',
      }),
      makeRoom({
        id: 'east-guest',
        name: 'East guest room',
        kind: 'bedroom',
        x: 12,
        z: 5,
        width: 6,
        depth: 6,
        west: 'glass',
      }),
      makeRoom({
        id: 'west-court',
        name: 'West courtyard',
        kind: 'courtyard',
        x: -7.5,
        z: 3,
        width: 3,
        depth: 9,
      }),
      makeRoom({
        id: 'east-court',
        name: 'East courtyard',
        kind: 'courtyard',
        x: 7.5,
        z: 3,
        width: 3,
        depth: 9,
      }),
      makeRoom({
        id: 'terrace',
        name: 'Living terrace',
        kind: 'terrace',
        x: 0,
        z: 8,
        width: 12,
        depth: 4,
      }),
    ],
    stairs: [
      { id: 'west-stair', x: -5, z: 0, elevation: 0, rise: 3.2, width: 1.4, run: 5, rotation: 180 },
      { id: 'east-stair', x: 5, z: 0, elevation: 0, rise: 3.2, width: 1.4, run: 5, rotation: 180 },
    ],
    fireplace: { x: 0, z: 0.5, elevation: 0, height: 7.6 },
  };
}

import { z } from 'zod';
import { emptyScene, makeRoom, type Room, type Scene, type Side } from './model.ts';
import { makeFurniture } from './furniture.ts';
import { executeCommands, type DesignCommand } from './design.ts';

export const composeHouseSchema = z.object({ recipe: z.literal('grand-lodge') }).strict();

export const grandLodgeDescriptor = {
  id: 'grand-lodge' as const,
  name: 'Timber Ridge Lodge',
  description:
    'A reviewable timber lodge seed with a dominant hall, two continuous subordinate wing roofs, a stone entry and linked upper reading gallery, public and private bathrooms, generous glazing and a furnished terrace.',
  roomIds: [
    'great-hall',
    'entry',
    'upper-gallery',
    'kitchen',
    'dining',
    'wing-gallery',
    'primary-suite',
    'primary-bath',
    'guest-bedroom',
    'guest-bath',
    'terrace',
  ],
  limitations: [
    'A schematic architectural seed, not a completed response to every brief.',
    'Roof intersections, circulation and visual character still require current renders and independent critique.',
    'No structural, weatherproofing or building-code certification.',
  ],
};

const piece = (
  kind: Parameters<typeof makeFurniture>[0],
  id: string,
  x: number,
  z: number,
  patch: Parameters<typeof makeFurniture>[2] = {},
) => makeFurniture(kind, id, { x, z, ...patch });
const window = (
  id: string,
  side: Side,
  offset: number,
  width: number,
  height: number,
  sill: number,
) => ({ id, side, kind: 'window' as const, offset, width, height, sill });
const room = (
  id: string,
  name: string,
  kind: Room['kind'],
  x: number,
  z: number,
  width: number,
  depth: number,
  height: number,
  patch: Partial<Room> = {},
) =>
  makeRoom({
    id,
    name,
    kind,
    x,
    z,
    width,
    depth,
    height,
    elevation: 0,
    north: 'solid',
    south: 'solid',
    east: 'solid',
    west: 'solid',
    palette: 'cedar',
    surfacePalettes: { roof: 'charcoal', floor: 'cedar' },
    furniture: [],
    ...patch,
  });

/** The complete seed is returned as replayable commands. Never adopts or saves a scene.
 * Shared code deliberately returns plain plan data; the server owns plan validation
 * and the original-request/current-image independent critique gates. */
export function composeHouseRecipe(
  input: unknown,
  originalRequest: string,
  baseScene: Scene = emptyScene,
) {
  composeHouseSchema.parse(input);
  if (baseScene.rooms.length || baseScene.stairs.length)
    throw new Error(
      'Compose a lodge only on an empty draft. Existing architecture requires scoped editing.',
    );

  const wingPitch = 22;
  const galleryHeight = 3.8 + 6 * Math.tan((wingPitch * Math.PI) / 180);
  const rooms: Room[] = [
    room('great-hall', 'Great Hall', 'living', 0, 0, 14, 12, 7.2, {
      roof: { style: 'pitched', pitch: 30, direction: 'north' },
      surfacePalettes: { north: 'limestone', roof: 'charcoal', floor: 'cedar' },
      wallOpenings: [
        window('hall-north-west', 'north', -5.3, 2.5, 4.8, 0.7),
        window('hall-north-center', 'north', 0.4, 2.4, 4.8, 0.7),
        window('hall-north-east', 'north', 5.9, 1.3, 4.8, 0.7),
        window('hall-south-west', 'south', -5.5, 2, 5, 0.8),
        window('hall-south-east', 'south', 5.5, 2, 5, 0.8),
        window('hall-east-gable', 'east', 0, 4, 1.5, 7.6),
        window('hall-west-gable', 'west', 0, 4, 1.5, 7.6),
      ],
      furniture: [
        piece('sofa', 'fireside-sofa', -2.4, 0, { width: 3.6, rotation: 180 }),
        piece('coffee-table', 'fireside-table', -2.4, -1.8, { width: 2, depth: 1 }),
        piece('armchair', 'fireside-west', -5.1, -2.5, { rotation: 90 }),
        piece('armchair', 'fireside-east', 0.3, -2.5, { rotation: 270 }),
        piece('rug', 'fireside-rug', -2.4, -1.5, { width: 6, depth: 4.8 }),
        piece('sofa', 'conversation-sofa', 3.8, 2.8, { width: 2.8, depth: 1, rotation: 270 }),
        piece('coffee-table', 'conversation-table', 1.9, 2.8, {
          width: 1.6,
          depth: 0.8,
          rotation: 90,
        }),
      ],
    }),
    room('entry', 'Stone Arrival Hall', 'hall', 0, 9, 8, 6, 2.8, {
      palette: 'limestone',
      roof: { style: 'flat' },
      wallOpenings: [
        {
          id: 'front-door',
          side: 'south',
          kind: 'door',
          offset: -2.3,
          width: 1.8,
          height: 2.5,
          sill: 0,
        },
        window('entry-south-window', 'south', 1.6, 2.8, 1.8, 0.7),
        window('entry-west-window', 'west', 0, 3.2, 1.8, 0.7),
        window('entry-east-window', 'east', 0, 3.2, 1.8, 0.7),
      ],
    }),
    room('upper-gallery', 'Upper Reading Gallery', 'hall', 0, 9, 8, 6, 2.6, {
      elevation: 2.8,
      palette: 'limestone',
      roof: { style: 'pitched', pitch: 24, direction: 'east' },
      wallOpenings: [
        window('gallery-front-glazing', 'south', -1.8, 3.4, 2, 0.5),
        window('gallery-front-stair-glazing', 'south', 2.1, 2.6, 2, 0.5),
        window('gallery-west-glazing', 'west', 0, 3.2, 1.8, 0.6),
        window('gallery-hall-overlook', 'north', -1.8, 3.4, 1.8, 0.6),
      ],
      furniture: [
        piece('sofa', 'reading-sofa', -2.5, 0, { width: 2.2, depth: 0.9, rotation: 90 }),
        piece('coffee-table', 'reading-table', -0.9, 0, { width: 1.2, depth: 0.6, rotation: 90 }),
      ],
    }),
    room('kitchen', 'Kitchen', 'kitchen', -11, -3, 8, 6, 4.5, {
      roof: { style: 'pitched', pitch: 28, direction: 'east' },
      wallOpenings: [
        window('kitchen-north', 'north', 0, 5.6, 2.3, 1.1),
        window('kitchen-west', 'west', 0, 3.6, 2.7, 0.8),
      ],
      furniture: [
        piece('counter', 'kitchen-counter', 0, -2.45, { width: 6.6, depth: 0.65 }),
        piece('island', 'kitchen-island', 0, 0, { width: 3.8, depth: 1.2 }),
      ],
    }),
    room('dining', 'Dining Hall', 'other', -11, 3, 8, 6, 4.5, {
      roof: { style: 'pitched', pitch: 28, direction: 'east' },
      wallOpenings: [
        window('dining-south', 'south', 0, 5.6, 2.7, 0.8),
        window('dining-west', 'west', 0, 3.6, 2.7, 0.8),
      ],
      furniture: [
        piece('dining-table', 'dining-table', 0, 0, { width: 4.2, depth: 1.2 }),
        ...[-1.5, 0, 1.5].flatMap((x, i) => [
          piece('chair', `dining-north-${i}`, x, -1.25),
          piece('chair', `dining-south-${i}`, x, 1.25, { rotation: 180 }),
        ]),
        piece('chair', 'dining-west', -2.8, 0, { rotation: 90 }),
        piece('chair', 'dining-east', 2.8, 0, { rotation: 270 }),
      ],
    }),
    room('wing-gallery', 'Guest Wing Gallery', 'hall', 15, 0, 16, 3, galleryHeight, {
      roof: { style: 'pitched', pitch: wingPitch, direction: 'north' },
      wallOpenings: [window('wing-gallery-east', 'east', 0, 1.8, 3.2, 0.9)],
    }),
    room('primary-suite', 'Primary Suite', 'bedroom', 12, -4.5, 10, 6, 3.8, {
      roof: { style: 'single-pitch', pitch: wingPitch, direction: 'south' },
      wallOpenings: [
        window('primary-north-west', 'north', -2.5, 3.4, 2.2, 0.8),
        window('primary-north-east', 'north', 2.5, 3.4, 2.2, 0.8),
      ],
      furniture: [
        piece('bed', 'primary-bed', 1.4, -0.8, { width: 2.3, depth: 2.5 }),
        piece('nightstand', 'primary-nightstand-west', -0.25, -1.5),
        piece('nightstand', 'primary-nightstand-east', 3.05, -1.5),
        piece('wardrobe', 'primary-wardrobe', 2.7, 2.6, { width: 3, rotation: 180 }),
        piece('sofa', 'primary-sitting', -3, -0.6, { width: 2.2, depth: 0.85, rotation: 90 }),
      ],
    }),
    room('primary-bath', 'Private Bath', 'bathroom', 20, -4.5, 6, 6, 3.8, {
      roof: { style: 'single-pitch', pitch: wingPitch, direction: 'south' },
      wallOpenings: [
        window('private-bath-north', 'north', 0, 3.2, 1.5, 1.1),
        window('private-bath-east', 'east', 0, 2.8, 1.5, 1.1),
      ],
      furniture: [
        piece('bath', 'private-bath', 1.2, -2.35, { width: 2 }),
        piece('vanity', 'private-vanity', 2.55, 0.6, { width: 1.5, rotation: 270 }),
        piece('toilet', 'private-toilet', -0.4, -2.2),
      ],
    }),
    room('guest-bedroom', 'Guest Suite', 'bedroom', 12, 4.5, 10, 6, 3.8, {
      roof: { style: 'single-pitch', pitch: wingPitch, direction: 'north' },
      wallOpenings: [
        window('guest-south-west', 'south', -2.5, 3.4, 2.2, 0.8),
        window('guest-south-east', 'south', 2.5, 3.4, 2.2, 0.8),
      ],
      furniture: [
        piece('bed', 'guest-bed', 2, 0.1, { width: 2.3, depth: 2.5 }),
        piece('nightstand', 'guest-nightstand-west', 0.35, -0.7),
        piece('nightstand', 'guest-nightstand-east', 3.65, -0.7),
        piece('wardrobe', 'guest-wardrobe', -4.55, 1.6, { rotation: 90 }),
        piece('armchair', 'guest-reading-chair', -2.4, 1.3, { rotation: 90 }),
      ],
    }),
    room('guest-bath', 'Shared Guest Bath', 'bathroom', 20, 4.5, 6, 6, 3.8, {
      roof: { style: 'single-pitch', pitch: wingPitch, direction: 'north' },
      wallOpenings: [
        window('guest-bath-south', 'south', 0, 3.2, 1.5, 1.1),
        window('guest-bath-east', 'east', 0, 2.8, 1.5, 1.1),
      ],
      furniture: [
        piece('bath', 'shared-bath', 1.2, 2.35, { width: 2, rotation: 180 }),
        piece('vanity', 'shared-vanity', -2.55, 0.5, { width: 1.5, rotation: 90 }),
        piece('toilet', 'shared-toilet', 2.1, -1, { rotation: 270 }),
      ],
    }),
    room('terrace', 'Timber View Terrace', 'terrace', 0, -10, 14, 8, 3, {
      furniture: [
        piece('dining-table', 'terrace-table', -3.5, 0, { width: 3, depth: 1.2 }),
        ...[-4.5, -3.5, -2.5].flatMap((x, i) => [
          piece('chair', `terrace-north-${i}`, x, -1.2),
          piece('chair', `terrace-south-${i}`, x, 1.2, { rotation: 180 }),
        ]),
        piece('sofa', 'terrace-sofa', 3.5, -2.3, { width: 3, depth: 1 }),
        piece('coffee-table', 'terrace-low-table', 3.5, -0.6, { width: 1.8, depth: 0.9 }),
      ],
    }),
  ];
  const connection = (
    id: string,
    roomAId: string,
    roomBId: string,
    width: number,
    center: number,
    kind: 'open' | 'door' = 'door',
    height = 2.4,
  ): DesignCommand => ({
    type: 'connect_rooms',
    connectionId: id,
    roomAId,
    roomBId,
    kind,
    width,
    height,
    center,
  });
  const operations: DesignCommand[] = [
    { type: 'update_site', name: grandLodgeDescriptor.name, roof: 'flat' },
    { type: 'set_material', palette: 'cedar' },
    { type: 'add_rooms', rooms },
    connection('arrival-to-hall', 'entry', 'great-hall', 2.4, -2, 'open'),
    connection('hall-to-kitchen', 'great-hall', 'kitchen', 3, -3, 'open'),
    connection('hall-to-dining', 'great-hall', 'dining', 3, 3, 'open'),
    connection('kitchen-to-dining', 'kitchen', 'dining', 3.2, -11, 'open'),
    connection('hall-to-guest-gallery', 'great-hall', 'wing-gallery', 2.4, 0, 'open'),
    connection('gallery-to-primary', 'wing-gallery', 'primary-suite', 1.6, 10.5),
    connection('primary-to-private-bath', 'primary-suite', 'primary-bath', 1.2, -4.5),
    connection('gallery-to-guest', 'wing-gallery', 'guest-bedroom', 1.4, 10.5),
    connection('gallery-to-public-bath', 'wing-gallery', 'guest-bath', 1.2, 20),
    connection('hall-to-terrace', 'great-hall', 'terrace', 2.6, 3.6, 'door', 3),
    { type: 'set_fireplace', fireplace: { x: -2.4, z: -4.9, elevation: 0, height: 11.4 } },
    {
      type: 'add_stairs',
      stairs: [
        {
          id: 'gallery-stair',
          x: 1.7,
          z: 9,
          elevation: 0,
          rise: 2.8,
          width: 1.4,
          run: 3.6,
          rotation: 0,
        },
      ],
    },
    {
      type: 'link_stairs',
      stairId: 'gallery-stair',
      lowerRoomId: 'entry',
      upperRoomId: 'upper-gallery',
    },
  ];
  const result = executeCommands(baseScene, operations);
  const errors = result.issues.filter((issue) => issue.severity === 'error');
  if (!result.applied || errors.length)
    throw new Error(
      `The lodge seed failed geometry validation: ${errors.map((issue) => `${issue.code}: ${issue.message}`).join('; ')}`,
    );
  const plan = {
    intent:
      `Develop and independently review this architectural seed against the owner's request: ${originalRequest}`.slice(
        0,
        500,
      ),
    scope: 'composition' as const,
    roomProgram: rooms.map((item) => ({
      roomId: item.id,
      name: item.name,
      kind: item.kind,
      purpose:
        item.id === 'guest-bath'
          ? 'A shared bathroom reached from common circulation without passing through a bedroom.'
          : item.id === 'upper-gallery'
            ? 'A furnished reading gallery reached by the linked stair, with an interior view into the hall.'
            : `Purposeful ${item.name.toLowerCase()} within the coordinated lodge.`,
      priority: 'required' as const,
      ...(item.kind !== 'terrace' ? { daylight: 'exterior_windows' as const } : {}),
    })),
    materialStrategy: {
      description:
        'Predominant timber, stone entry/hearth planes, and one coordinated charcoal roof over a dominant hall, two continuous subordinate wings and a stone entry.',
      checks: [
        {
          kind: 'material_composition' as const,
          surfaces: ['exterior-walls' as const],
          allowedPalettes: ['cedar' as const, 'limestone' as const],
          maxDistinct: 2,
        },
        {
          kind: 'material_composition' as const,
          surfaces: ['roof' as const],
          allowedPalettes: ['charcoal' as const],
          maxDistinct: 1,
        },
      ],
    },
    fenestration: {
      description:
        'Dimensioned exterior glazing in each indoor use, preserving sheltered connections and the real arrival door.',
      roomIds: rooms.filter((item) => item.kind !== 'terrace').map((item) => item.id),
      minCountPerRoom: 1,
      minAreaPerRoom: 1.2,
    },
    features: [
      {
        id: 'arrival',
        request: 'A real dimensioned south exterior entrance into the stone arrival hall.',
        priority: 'required' as const,
        checks: [
          {
            kind: 'opening_item' as const,
            roomId: 'entry',
            side: 'south' as const,
            openingId: 'front-door',
            openingKind: 'door' as const,
            width: 1.8,
            height: 2.5,
            sill: 0,
          },
        ],
      },
      {
        id: 'lodge-amenities',
        request:
          'A usable hearth, furnished terrace, linked upper reading gallery and publicly accessible guest bathroom.',
        priority: 'required' as const,
        checks: [
          { kind: 'feature' as const, feature: 'fireplace' as const, roomId: 'great-hall' },
          { kind: 'feature' as const, feature: 'terrace' as const, roomId: 'terrace' },
          { kind: 'feature' as const, feature: 'linked_stair' as const, roomId: 'upper-gallery' },
          { kind: 'indoor_route' as const, roomIds: ['great-hall', 'wing-gallery', 'guest-bath'] },
        ],
        judgment:
          'Inspect the real doorway/stair approaches, guest access without private rooms, a dominant hall, two continuous subordinate wing roofs and furniture placement in current views.',
      },
    ],
    reviewViews: ['exterior', 'plan'] as const,
    assumptions: [],
  };
  return { scene: result.scene, plan, operations };
}

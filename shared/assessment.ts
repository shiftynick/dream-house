import { z } from 'zod';
import { inspectDesign } from './design.ts';
import { effectiveRoof } from './architecture.ts';
import { roomOpenings } from './openings.ts';
import { paletteSchema, sideSchema, surfaceSchema, type Scene } from './model.ts';
import { roomFurniture } from './furniture.ts';
import { furnitureBlockingCodes } from './furniture-layout.ts';
import { inspectRoomFurniture } from './spatial.ts';

const id = z.string().min(1).max(60);
const tolerance = z.number().finite().min(0).max(0.5).default(0.01);
export const designAssertionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('furniture_layout'), roomId: id }).strict(),
  z
    .object({
      kind: z.literal('furniture_item'),
      roomId: id,
      furnitureId: id,
      present: z.boolean().default(true),
      x: z.number().optional(),
      z: z.number().optional(),
      rotation: z.number().optional(),
      width: z.number().optional(),
      depth: z.number().optional(),
    })
    .strict(),
  z
    .object({ kind: z.literal('room_exists'), roomId: id, present: z.boolean().default(true) })
    .strict(),
  z
    .object({
      kind: z.literal('room_dimension'),
      roomId: id,
      dimension: z.enum(['width', 'depth', 'height', 'elevation']),
      comparison: z.enum(['equal', 'at_least', 'at_most']).default('equal'),
      value: z.number().finite().min(-30).max(120),
      tolerance,
    })
    .strict(),
  z
    .object({
      kind: z.literal('roof'),
      roomId: id,
      style: z.enum(['flat', 'pitched', 'single-pitch']),
      pitch: z.number().finite().min(0).max(60).optional(),
      direction: sideSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('wall_opening'),
      roomId: id,
      side: sideSchema,
      openingKind: z.enum(['window', 'door', 'open']),
      minCount: z.number().int().min(1).max(20).default(1),
      minWidth: z.number().finite().min(0).max(30).optional(),
      minHeight: z.number().finite().min(0).max(10).optional(),
    })
    .strict(),
  z.object({ kind: z.literal('indoor_route'), roomIds: z.array(id).min(2).max(32) }).strict(),
  z
    .object({
      kind: z.literal('material'),
      roomId: id,
      palette: paletteSchema,
      surface: surfaceSchema.optional(),
    })
    .strict(),
]);
export const designAssessmentSchema = z
  .object({
    requirements: z
      .array(
        z
          .object({
            id,
            request: z.string().min(1).max(280),
            priority: z.enum(['required', 'preference']).default('required'),
            status: z.enum(['fulfilled', 'partial', 'unmet', 'unverified']),
            evidence: z.string().min(1).max(500),
            limitation: z.string().min(1).max(360).optional(),
            checks: z.array(designAssertionSchema).max(8).default([]),
          })
          .strict(),
      )
      .min(1)
      .max(12),
    assumptions: z
      .array(
        z
          .object({
            description: z.string().min(1).max(280),
            requiresConfirmation: z.boolean(),
          })
          .strict(),
      )
      .max(8)
      .default([]),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    for (const [index, requirement] of value.requirements.entries()) {
      if (ids.has(requirement.id))
        context.addIssue({
          code: 'custom',
          path: ['requirements', index, 'id'],
          message: 'Requirement IDs must be unique.',
        });
      ids.add(requirement.id);
    }
  });
export type DesignAssessment = z.infer<typeof designAssessmentSchema>;
export type AssertionResult = { passed: boolean; actual: unknown; reason: string };
export type EvaluatedAssessment = {
  requirements: Array<
    DesignAssessment['requirements'][number] & {
      verification: 'geometry' | 'model';
      results: AssertionResult[];
    }
  >;
  assumptions: DesignAssessment['assumptions'];
  requiresConfirmation: boolean;
};

/** Evaluate explicit assertions against shared geometry, never infer intent from keywords. */
export function evaluateDesignAssessment(
  scene: Scene,
  input: DesignAssessment,
): EvaluatedAssessment {
  const inspection = inspectDesign(scene);
  const check = (assertion: z.infer<typeof designAssertionSchema>): AssertionResult => {
    if (assertion.kind === 'indoor_route') {
      const component = inspection.components.find((ids) =>
        assertion.roomIds.every((id) => ids.includes(id)),
      );
      return {
        passed: !!component,
        actual: inspection.components,
        reason: component
          ? 'Rooms share an indoor circulation component.'
          : 'No shared indoor route connects all requested rooms.',
      };
    }
    const room = scene.rooms.find((item) => item.id === assertion.roomId);
    if (assertion.kind === 'room_exists')
      return {
        passed: !!room === assertion.present,
        actual: !!room,
        reason: room ? 'Room exists.' : 'Room is absent.',
      };
    if (!room)
      return { passed: false, actual: null, reason: `Room ${assertion.roomId} does not exist.` };
    if (assertion.kind === 'furniture_item') {
      const item = roomFurniture(room).find((item) => item.id === assertion.furnitureId);
      const fields = ['x', 'z', 'rotation', 'width', 'depth'] as const;
      const passed = assertion.present
        ? !!item &&
          fields.every(
            (field) =>
              assertion[field] === undefined || Math.abs(item[field] - assertion[field]!) <= 0.01,
          )
        : !item;
      return {
        passed,
        actual: item || null,
        reason: passed
          ? `Furniture ${assertion.furnitureId} matches the requested values.`
          : `Furniture ${assertion.furnitureId} does not match the requested values.`,
      };
    }
    if (assertion.kind === 'furniture_layout') {
      const problems = inspectRoomFurniture(scene, room).filter((problem) =>
        furnitureBlockingCodes.has(problem.code),
      );
      return {
        passed: !problems.length,
        actual: problems,
        reason: problems.length
          ? problems.map((p) => p.message).join(' ')
          : `${room.name} furniture fits without detected overlaps or blocked doors/stairs. Aisle checks remain advisory.`,
      };
    }
    if (assertion.kind === 'room_dimension') {
      const actual = room[assertion.dimension];
      const difference = actual - assertion.value;
      const passed =
        assertion.comparison === 'equal'
          ? Math.abs(difference) <= assertion.tolerance
          : assertion.comparison === 'at_least'
            ? difference >= -assertion.tolerance
            : difference <= assertion.tolerance;
      return { passed, actual, reason: `${room.name} ${assertion.dimension} is ${actual} m.` };
    }
    if (assertion.kind === 'roof') {
      const actual = effectiveRoof(scene, room);
      return {
        passed:
          actual.style === assertion.style &&
          (assertion.pitch === undefined || Math.abs(actual.pitch - assertion.pitch) <= 0.01) &&
          (assertion.direction === undefined || actual.direction === assertion.direction),
        actual,
        reason: `${room.name} uses a ${actual.style} roof at ${actual.pitch}°, high edge ${actual.direction}.`,
      };
    }
    if (assertion.kind === 'wall_opening') {
      const explicit = roomOpenings(scene, room.id, assertion.side);
      const wall = room[assertion.side];
      const wallWidth =
        assertion.side === 'north' || assertion.side === 'south' ? room.width : room.depth;
      const legacy =
        wall === 'glass'
          ? [{ kind: 'window', width: wallWidth, height: room.height }]
          : wall === 'door'
            ? [
                {
                  kind: 'door',
                  width: Math.min(1.3, wallWidth),
                  height: Math.min(2.4, room.height),
                },
              ]
            : wall === 'open'
              ? [{ kind: 'open', width: wallWidth, height: room.height }]
              : [];
      const actual = (explicit.length ? explicit : legacy).filter(
        (opening) => opening.kind === assertion.openingKind,
      );
      const matching = actual.filter(
        (opening) =>
          opening.width + 0.01 >= (assertion.minWidth || 0) &&
          opening.height + 0.01 >= (assertion.minHeight || 0),
      );
      return {
        passed: matching.length >= assertion.minCount,
        actual,
        reason: `${matching.length} ${assertion.openingKind} opening(s) on ${room.name}'s ${assertion.side} wall meet the specified dimensions.`,
      };
    }
    const actual = assertion.surface
      ? (room.surfacePalettes?.[assertion.surface] ?? room.palette ?? scene.palette)
      : (room.palette ?? scene.palette);
    return {
      passed: actual === assertion.palette,
      actual,
      reason: `${room.name}${assertion.surface ? ` ${assertion.surface}` : ''} palette is ${actual}.`,
    };
  };
  const requirements: EvaluatedAssessment['requirements'] = input.requirements.map(
    (requirement) => {
      const results = requirement.checks.map(check);
      const failed = results.filter((result) => !result.passed);
      return {
        ...requirement,
        status:
          failed.length && requirement.status === 'fulfilled' ? 'partial' : requirement.status,
        limitation: failed.length
          ? failed.map((result) => result.reason).join(' ')
          : requirement.limitation,
        verification: results.length ? 'geometry' : 'model',
        results,
      };
    },
  );
  return {
    requirements,
    assumptions: input.assumptions,
    requiresConfirmation:
      requirements.some((item) => item.priority === 'required' && item.status !== 'fulfilled') ||
      input.assumptions.some((item) => item.requiresConfirmation),
  };
}

export function assessmentDisclosure(assessment: EvaluatedAssessment): string {
  const unfinished = assessment.requirements.filter((item) => item.status !== 'fulfilled');
  const consequential = assessment.assumptions.filter((item) => item.requiresConfirmation);
  return [
    ...unfinished.map(
      (item) =>
        `${item.status === 'unverified' ? 'Unverified' : 'Still outstanding'}: ${item.request}${item.limitation ? ` — ${item.limitation}` : ''}`,
    ),
    ...consequential.map((item) => `Assumption for your approval: ${item.description}`),
  ].join('\n');
}

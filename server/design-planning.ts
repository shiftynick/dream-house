import { z } from 'zod';
import { canonical } from '../shared/draft.ts';
import { roomSchema } from '../shared/model.ts';
import {
  designAssessmentSchema,
  designAssertionSchema,
  evaluateDesignAssessment,
  type DesignAssessment,
  type EvaluatedAssessment,
} from '../shared/assessment.ts';
import type { Scene } from '../shared/model.ts';

const id = z.string().min(1).max(60);
export const designPlanSchema = z
  .object({
    intent: z.string().min(1).max(500),
    scope: z.enum(['composition', 'focused']).default('composition'),
    roomProgram: z
      .array(
        z
          .object({
            roomId: id,
            name: z.string().min(1).max(80),
            kind: roomSchema.shape.kind,
            purpose: z.string().min(1).max(180),
            priority: z.enum(['required', 'preference']).default('required'),
            daylight: z.enum(['exterior_windows', 'interior_allowed']).optional(),
            daylightReason: z.string().min(1).max(180).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(16),
    materialStrategy: z
      .object({
        description: z.string().min(1).max(280),
        checks: z.array(designAssertionSchema).min(1).max(4),
      })
      .strict()
      .optional(),
    fenestration: z
      .object({
        description: z.string().min(1).max(280),
        roomIds: z.array(id).min(1).max(16),
        minCountPerRoom: z.number().int().min(1).max(12).default(1),
        minAreaPerRoom: z.number().finite().min(0).max(60).default(0),
      })
      .strict()
      .optional(),
    features: z
      .array(
        z
          .object({
            id,
            request: z.string().min(1).max(280),
            priority: z.enum(['required', 'preference']).default('required'),
            checks: z.array(designAssertionSchema).max(8).default([]),
            judgment: z.string().min(1).max(280).optional(),
          })
          .strict(),
      )
      .max(6)
      .default([]),
    reviewViews: z
      .array(z.enum(['exterior', 'interior', 'plan', 'cutaway']))
      .min(1)
      .max(3),
    assumptions: designAssessmentSchema.shape.assumptions,
  })
  .strict()
  .superRefine((plan, context) => {
    const ids = plan.roomProgram.map((room) => room.roomId);
    if (new Set(ids).size !== ids.length)
      context.addIssue({
        code: 'custom',
        path: ['roomProgram'],
        message: 'Room program IDs must be unique.',
      });
    if (plan.fenestration?.roomIds.some((roomId) => !ids.includes(roomId)))
      context.addIssue({
        code: 'custom',
        path: ['fenestration', 'roomIds'],
        message: 'Fenestration targets must belong to the declared room program.',
      });
    if (plan.scope === 'composition') {
      if (plan.reviewViews.length !== 2 || new Set(plan.reviewViews).size !== 2)
        context.addIssue({
          code: 'custom',
          path: ['reviewViews'],
          message:
            'Choose exactly two distinct critique views: exterior plus one plan/interior/cutaway, leaving two captures for fresh views after a repair.',
        });
      if (
        !plan.reviewViews.includes('exterior') ||
        !plan.reviewViews.some((view) => view !== 'exterior')
      )
        context.addIssue({
          code: 'custom',
          path: ['reviewViews'],
          message:
            'A composition needs exterior and at least one plan/interior/cutaway critique view.',
        });
      if (!plan.materialStrategy?.checks.some((check) => check.kind === 'material_composition'))
        context.addIssue({
          code: 'custom',
          path: ['materialStrategy', 'checks'],
          message: 'Declare a typed material_composition check for a composition.',
        });
      const daylightRooms = plan.roomProgram.filter(
        (room) =>
          room.priority === 'required' &&
          (['living', 'kitchen', 'bedroom'].includes(room.kind) ||
            room.daylight === 'exterior_windows'),
      );
      if (
        !plan.fenestration ||
        daylightRooms.some((room) => !plan.fenestration?.roomIds.includes(room.roomId))
      )
        context.addIssue({
          code: 'custom',
          path: ['fenestration', 'roomIds'],
          message: 'Include required occupied rooms in the dimensioned exterior-window plan.',
        });
    }
    if (
      plan.roomProgram.some((room) => room.daylight === 'interior_allowed' && !room.daylightReason)
    )
      context.addIssue({
        code: 'custom',
        path: ['roomProgram'],
        message: 'Explain intentional internally lit/service-room exceptions.',
      });
    const featureIds = plan.features.map((feature) => feature.id);
    if (
      new Set(featureIds).size !== featureIds.length ||
      featureIds.some((value) => value.startsWith('plan-'))
    )
      context.addIssue({
        code: 'custom',
        path: ['features'],
        message: 'Feature IDs must be unique and must not use the reserved plan- prefix.',
      });
    try {
      planAssessment(plan);
    } catch {
      context.addIssue({
        code: 'custom',
        message:
          'The initial plan must fit eight assessment objectives (eight checks each), leaving four slots for independent critic findings. Group related features or reduce optional detail.',
      });
    }
  });
export type DesignPlan = z.infer<typeof designPlanSchema>;

/** Translate the declared design into immutable, locally checked assessment objectives. */
export function planAssessment(plan: DesignPlan): DesignAssessment {
  const requirements: DesignAssessment['requirements'] = [];
  const add = (
    id: string,
    request: string,
    checks: DesignAssessment['requirements'][number]['checks'],
    priority: 'required' | 'preference' = 'required',
  ) =>
    requirements.push({
      id,
      request,
      priority,
      checks,
      status: 'unmet',
      evidence: 'Planned before editing; not yet completed.',
    });
  add('plan-intent', 'Fulfill the original request with a coherent, complete design.', []);
  for (const priority of ['required', 'preference'] as const) {
    const rooms = plan.roomProgram.filter((room) => room.priority === priority);
    const checks = rooms.map((room) =>
      designAssertionSchema.parse({ kind: 'room_exists', roomId: room.roomId }),
    );
    for (const kind of new Set(rooms.map((room) => room.kind)))
      checks.push(
        designAssertionSchema.parse({
          kind: 'room_program',
          roomKind: kind,
          roomIds: rooms.filter((room) => room.kind === kind).map((room) => room.roomId),
          minCount: rooms.filter((room) => room.kind === kind).length,
        }),
      );
    const indoor = rooms.filter((room) => !['terrace', 'courtyard'].includes(room.kind));
    if (priority === 'required' && indoor.length > 1)
      checks.push(
        designAssertionSchema.parse({
          kind: 'indoor_route',
          roomIds: indoor.map((room) => room.roomId),
        }),
      );
    for (let index = 0; index < checks.length; index += 8)
      add(
        `plan-program-${priority}-${index / 8 + 1}`,
        `Complete the declared ${priority} room program and its indoor circulation.`,
        checks.slice(index, index + 8),
        priority,
      );
  }
  if (plan.materialStrategy)
    add('plan-materials', plan.materialStrategy.description, plan.materialStrategy.checks);
  if (plan.fenestration)
    add('plan-windows', plan.fenestration.description, [
      designAssertionSchema.parse({
        kind: 'exterior_windows',
        roomIds: plan.fenestration.roomIds,
        minCountPerRoom: plan.fenestration.minCountPerRoom,
        minAreaPerRoom: plan.fenestration.minAreaPerRoom,
      }),
    ]);
  for (const feature of plan.features)
    add(feature.id, feature.request, feature.checks, feature.priority);
  if (requirements.length > 8) throw new Error('Initial plan exceeds eight objectives.');
  return designAssessmentSchema.parse({ requirements, assumptions: plan.assumptions });
}

/** Builder statuses may change, while initial request text, priorities and checks stay fixed. */
export function plannedAssessment(
  plan: DesignAssessment,
  supplied?: DesignAssessment,
): DesignAssessment {
  const requirements = plan.requirements.map((original) => {
    const next = supplied?.requirements.find((item) => item.id === original.id);
    return {
      ...(next || original),
      request: original.request,
      priority: original.priority,
      checks: [
        ...new Map(
          [...original.checks, ...(next?.checks || [])].map((check) => [canonical(check), check]),
        ).values(),
      ],
    };
  });
  for (const extra of supplied?.requirements || [])
    if (!requirements.some((item) => item.id === extra.id)) requirements.push(extra);
  const assumptions = [
    ...new Map(
      [...plan.assumptions, ...(supplied?.assumptions || [])].map((item) => [
        item.description,
        item,
      ]),
    ).values(),
  ];
  for (const original of plan.assumptions)
    if (original.requiresConfirmation)
      assumptions.find((item) => item.description === original.description)!.requiresConfirmation =
        true;
  return designAssessmentSchema.parse({ requirements, assumptions });
}

export function evaluatePlan(
  scene: Scene,
  plan: DesignAssessment,
  baseline: Scene,
  supplied?: DesignAssessment,
): EvaluatedAssessment {
  return evaluateDesignAssessment(scene, plannedAssessment(plan, supplied), baseline);
}

/** Candidate-state gate: do not commit windows before required room massing and routes exist. */
export function compositionWindowPhase(
  before: Scene,
  candidate: Scene,
  objectives: DesignAssessment,
  baseline: Scene,
) {
  const windows = (scene: Scene) =>
    new Map(
      scene.rooms.flatMap((room) =>
        (room.wallOpenings || [])
          .filter((opening) => opening.kind === 'window')
          .map((opening) => [`${room.id}:${opening.id}`, canonical(opening)] as const),
      ),
    );
  const previous = windows(before);
  const introducesWindows = [...windows(candidate)].some(
    ([key, value]) => previous.get(key) !== value,
  );
  if (!introducesWindows) return undefined;
  const evaluated = evaluatePlan(candidate, objectives, baseline);
  const incomplete = evaluated.requirements.flatMap((item) =>
    item.priority !== 'required'
      ? []
      : item.checks.flatMap((check, index) =>
          ['room_exists', 'room_program', 'indoor_route'].includes(check.kind) &&
          !item.results[index].passed
            ? [{ objectiveId: item.id, check, result: item.results[index] }]
            : [],
        ),
  );
  return incomplete.length ? incomplete : undefined;
}

export const designCritiqueSchema = z
  .object({
    intentReview: z
      .object({
        status: z.enum(['adequate', 'needs_work', 'unverified']),
        evidence: z.string().min(1).max(1000),
        missingObjectives: z
          .array(
            z
              .object({
                id,
                request: z.string().min(1).max(280),
                checks: z.array(designAssertionSchema).max(8).default([]),
              })
              .strict(),
          )
          .max(4)
          .default([]),
      })
      .strict(),
    captureIds: z.array(id).max(4).default([]),
    observations: z
      .array(
        z
          .object({
            objectiveId: id,
            status: z.enum(['satisfactory', 'needs_repair', 'unverified']),
            evidence: z.string().min(1).max(1000),
            repair: z.string().min(1).max(360).optional(),
            limitation: z.string().min(1).max(360).optional(),
            constraint: z.enum(['unsupported', 'visibility']).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(12),
    limitations: z.array(z.string().min(1).max(360)).max(8).default([]),
  })
  .strict();
export type DesignCritique = z.infer<typeof designCritiqueSchema>;
export type EvaluatedDesignCritique = {
  sceneHash: string;
  critique: DesignCritique;
  assessment: EvaluatedAssessment;
  requiresConfirmation: boolean;
};

export function critiqueObjectiveError(assessment: DesignAssessment, critique: DesignCritique) {
  const ids = critique.observations.map((item) => item.objectiveId);
  if (
    new Set(ids).size !== ids.length ||
    ids.some((id) => !assessment.requirements.some((item) => item.id === id)) ||
    assessment.requirements.some((item) => !ids.includes(item.id))
  )
    return 'Critique every immutable planned objective exactly once using its original objectiveId.';
  return undefined;
}

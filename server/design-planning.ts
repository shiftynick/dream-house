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

/** Capability-specific design advice, not a fixed layout or a universal room schedule. */
export const ARCHITECTURAL_COMPOSITION_GUIDANCE = `
ARCHITECTURAL COMPOSITION WITH THE AVAILABLE TOOLS
For an ambitious brief, make architectural decisions in the first plan and shell rather than expecting window enlargement or furniture alone to turn a generic box into an accomplished composition. Choose a clear primary gathering volume, substantial complementary occupied wings, a legible arrival and a useful outdoor destination when appropriate to the owner's brief. Give major wings enough wall height, roof pitch and depth to support the intended scale; reserve noticeably lower appendages for deliberate secondary roles. Coordinate ridge directions, eaves, shared boundaries and roof transitions. set_roof supports pitched and single-pitch roofs with pitch/direction; update_room.height raises eaves without introducing a new floor level. Actual changes in floor elevation need aligned stair connections and reviewed circulation. No particular number of rooms, floors or bedrooms establishes grandeur.
Choose one predominant wall material and a purposeful accent placement, such as a stone hall/base/entry or selected wall planes within a timber composition. Use surface palettes to keep roof color consistent across different wall materials; room.palette changes every inherited surface. A material_composition allowed set alone does not establish a coherent balance. Palette names describe material collections, not literal products: verify actual roof appearance in images before claiming timber shingles, stone construction or a particular finish. A contrasting roof should be an explicit architectural choice rather than accidental room-palette inheritance.
Design the arrival as an actual route from outside through a dimensioned exterior door into the intended entry and main circulation. A glazed foyer with only an internal door is not an entrance. Make an entry/foyer volume and its gable proportions purposeful relative to the main building, with an appropriate door position and useful space inside. After final massing, inspect the chosen outward wall and neighboring rooms to prove the door faces outdoors rather than another indoor room. Add a required feature check using {kind:'wall_opening',roomId:<chosen arrival room>,side:<inspected exterior side>,openingKind:'door',minCount:1,minWidth:<your chosen width>,minHeight:<your chosen height>}. Those dimensions are design choices, not universal standards. This typed check proves door dimensions only; the shared-wall inspection must separately establish exterior exposure. An indoor_route check or a room named Entry cannot replace this evidence. set_wall_openings replaces standalone apertures on that face: include the exterior door whenever adding or replacing windows on the same wall.
Finish all required room massing and connections before detailed fenestration. Use the actual exposed, unoccupied wall rectangles to place generous dimensioned windows for the intended use, views and proportions, with solid wall/roof continuity above low wings. Large high windows can occupy supported gable/clerestory geometry after roof limits are inspected; open gaps are not glazing. Coordinate sill/head heights across related elevations and preserve arrival doors and internal passages. Review both the approach elevation and the plan, including portions hidden behind taller volumes.
Make selected features usable in the first furnished scheme. Arrange gathering seats toward a modeled fireplace and check the whole hearth footprint inside its room, circulation past it and separation from the coffee table; the fireplace center alone is insufficient. Place its chimney purposefully relative to the roof profile. Furnish dining and sleeping uses, bathroom fixtures and storage through available furniture operations. A chosen terrace should connect through a real door and have a purposeful table/chair or seating arrangement that leaves arrival/circulation clear. Terrace/courtyard kinds render a floor/deck and furniture, with no enclosing roof or walls; setting their roof or wall flags does not create a roofed pavilion, balustrade or covered porch. Custom trusses, log profiles, railings, landscaping paths and bespoke structural detailing are not dedicated primitives here. Do not promise them from names or dormant flags; realize the strongest supported composition and state relevant limits honestly.
`;

export const ARCHITECTURAL_CRITIQUE_GUIDANCE = `
CAPABILITY-AWARE ARCHITECTURAL REVIEW
Evaluate the original ambition through the supported massing, roof hierarchy, coordinated materials, real glazing, arrival and usable furnishing. A room count or a tall hall alone is not proof of a grand or coherent design. Examine major occupied wings and the entry as parts of the whole composition, and identify a specific feasible change when their scale or proportions are inadequate. Distinguish a factual functional failure from a subjective architectural judgment and from an optional refinement; retain needs_work when the actual result does not meet the brief.
Explicitly trace arrival from outdoors. Find a real dimensioned exterior door on the intended arrival room's exposed wall, then its route into the house. Check the opening's kind, side and dimensions against neighboring volumes. A room labelled Entry, an internal door, exterior windows or a connected indoor graph does not establish an outside entrance. If the intended entry has no exterior door, report the missing functional arrival and request a door that preserves existing glazing on that face. Do not prescribe an arbitrary universal door width.
Check actual windows and wall continuity above low adjoining roofs, deliberate wall/roof material assignments, furniture purpose, hearth fit and circulation, and the chosen terrace's usable access/furnishing. Pixels may hide the entry, rear terrace, hearth or interior volume: use geometry for factual presence, disclose visual limits, and do not claim hidden details were inspected. Clearance warnings are schematic assumptions; do not turn every chair/table or wall-adjacent nightstand warning into an essential redesign. Wall-adjacent bathtubs and vanities can be intentional usable layouts: an assumed 0.6 m gap on every side is not a universal requirement. Identify the actual access face and obstruction before calling a bath fixture unusable.
Repairs must be achievable with the exposed operations: room dimensions/placement/heights, supported roof styles and slopes, surface palettes, dimensioned apertures, connections, furniture and fireplace placement. For a broad ambitious brief, do not make unsupported decorative trusses, bespoke log construction, railings, roofed terrace flags, detailed landscape works or an invented bedroom/storey count mandatory. Terrace/courtyard kinds render floor and furniture only. Suggest achievable alternatives that address the identified shortcoming; do not erase a real needs_work finding merely because optional ornament is unavailable. Judge literal materials from rendered evidence, not palette names. Keep subjective style judgments labelled and reserve new required objectives for essential function or explicit owner commitments.
`;

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
            'Choose exactly two distinct critique views: exterior plus one plan/interior/cutaway, leaving four captures for fresh pairs after up to two repairs.',
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
    captureIds: z.array(id).max(6).default([]),
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

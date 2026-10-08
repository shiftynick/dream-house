import { z } from 'zod';
import { canonical } from './draft.ts';
import { effectiveRoof } from './architecture.ts';
import { effectiveSurfacePalettes } from './design.ts';
import type { Scene } from './model.ts';
import { roomFurniture } from './furniture.ts';
import type { RenderRequest, RenderCamera } from './render.ts';
import type { DesignSelection } from './selection.ts';

export const visualReviewSchema = z
  .object({
    status: z.enum(['passed', 'issues', 'unverified']),
    captureIds: z.array(z.string().min(1).max(60)).min(1).max(6),
    observations: z.array(z.string().trim().min(1).max(400)).min(1).max(6),
    limitations: z.array(z.string().trim().min(1).max(400)).max(6).default([]),
  })
  .strict()
  .refine((review) => new Set(review.captureIds).size === review.captureIds.length, {
    message: 'Capture IDs must be unique.',
  });
export type VisualReview = z.infer<typeof visualReviewSchema>;
export type VisualCaptureProvenance = RenderRequest & {
  captureId: string;
  sceneHash: string;
  camera: RenderCamera;
};
export type EvaluatedVisualReview = VisualReview & {
  verification: 'model';
  captures: VisualCaptureProvenance[];
  requiresConfirmation: boolean;
};

/** Changes to effective appearance require color evidence, rather than a diagram. */
export function changedAppearanceRoomIds(before: Scene, after: Scene): string[] {
  return after.rooms
    .filter((room) => {
      const previous = before.rooms.find((item) => item.id === room.id);
      return (
        !previous ||
        canonical(effectiveSurfacePalettes(before, previous)) !==
          canonical(effectiveSurfacePalettes(after, room)) ||
        canonical(effectiveRoof(before, previous)) !== canonical(effectiveRoof(after, room)) ||
        roomFurniture(room).some((item) => {
          const old = roomFurniture(previous).find((candidate) => candidate.id === item.id);
          return old
            ? (old.palette ?? previous.palette ?? before.palette) !==
                (item.palette ?? room.palette ?? after.palette)
            : item.palette !== undefined;
        })
      );
    })
    .map((room) => room.id);
}

export function needsColorReview(before: Scene, after: Scene): boolean {
  return changedAppearanceRoomIds(before, after).length > 0;
}

/** Exterior roof structure/palette cannot be assessed from a hidden cutaway roof or ceiling. */
export function changedRoofRoomIds(before: Scene, after: Scene): string[] {
  return after.rooms
    .filter((room) => {
      const previous = before.rooms.find((item) => item.id === room.id);
      return (
        !previous ||
        canonical(effectiveRoof(before, previous)) !== canonical(effectiveRoof(after, room)) ||
        effectiveSurfacePalettes(before, previous).roof !==
          effectiveSurfacePalettes(after, room).roof
      );
    })
    .map((room) => room.id);
}

export function evaluateVisualReview(options: {
  input?: VisualReview;
  captures: Map<string, VisualCaptureProvenance>;
  deliveredIds: Set<string>;
  sceneHash: string;
  original: Scene;
  scene: Scene;
  selection?: DesignSelection | null;
}): { error?: string; review?: EvaluatedVisualReview } {
  const { input, captures, deliveredIds, sceneHash, original, scene, selection } = options;
  if (!input)
    return {
      error:
        'Supply visualReview with captureIds, status and explicit observations of the delivered final-draft images.',
    };
  const evidence: VisualCaptureProvenance[] = [];
  for (const id of input.captureIds) {
    const capture = captures.get(id);
    if (!capture || !deliveredIds.has(id))
      return {
        error: `Capture ${id} has not been delivered for model review. Request a view and examine it in the next round.`,
      };
    if (capture.sceneHash !== sceneHash)
      return { error: `Capture ${id} is stale. Review a fresh view of the final edited draft.` };
    evidence.push(capture);
  }
  const color = evidence.filter((capture) => capture.quality === 'live' && capture.view !== 'plan');
  const changedAppearance = changedAppearanceRoomIds(original, scene);
  if (changedAppearance.length && !color.length)
    return {
      error:
        'Material or roof changes require a live 3D color capture; plan, clay and wireframe evidence cannot satisfy this review.',
    };
  const uncovered = changedAppearance.filter(
    (id) => !color.some((capture) => !capture.roomId || capture.roomId === id),
  );
  if (uncovered.length)
    return {
      error: `Review changed appearance in rooms ${uncovered.join(', ')} with matching focused live 3D captures or an unscoped whole-scene color view. Metadata does not prove visibility.`,
    };
  const changedRoofs = changedRoofRoomIds(original, scene);
  if (
    changedRoofs.some(
      (id) =>
        !color.some(
          (capture) => capture.view === 'exterior' && (!capture.roomId || capture.roomId === id),
        ),
    )
  )
    return {
      error:
        'Changed roof structure or palette requires a live exterior capture of the house or each affected room; interior ceilings and cutaways do not show the exterior roof.',
    };
  if (selection && ['north', 'south', 'east', 'west'].includes(selection.surface)) {
    const before = original.rooms.find((room) => room.id === selection.roomId);
    const after = scene.rooms.find((room) => room.id === selection.roomId);
    const surface = selection.surface as 'north' | 'south' | 'east' | 'west';
    const changed =
      after &&
      (!before ||
        effectiveSurfacePalettes(original, before)[surface] !==
          effectiveSurfacePalettes(scene, after)[surface]);
    if (
      changed &&
      !color.some((capture) => {
        if (capture.roomId && capture.roomId !== selection.roomId) return false;
        if (capture.view !== 'interior') return true;
        // Interior presets face away from the camera's named corner. Metadata
        // establishes orientation only; it cannot certify visibility or occlusion.
        return surface === 'north'
          ? capture.angle.startsWith('south')
          : surface === 'south'
            ? capture.angle.startsWith('north')
            : surface === 'east'
              ? capture.angle.endsWith('west')
              : capture.angle.endsWith('east');
      })
    )
      return {
        error:
          'Review the changed selected wall with an appropriately oriented interior capture or a relevant exterior/cutaway color view. Metadata does not prove visibility.',
      };
  }
  return {
    review: {
      ...input,
      captures: evidence,
      verification: 'model',
      requiresConfirmation: input.status !== 'passed',
    },
  };
}

export function visualReviewDisclosure(review: EvaluatedVisualReview): string {
  if (!review.requiresConfirmation) return '';
  return `Visual review (${review.status}; model judgment): ${[...review.observations, ...review.limitations].join(' ')}`;
}

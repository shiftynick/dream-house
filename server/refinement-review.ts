import { createHash } from 'node:crypto';
import { canonical } from '../shared/draft.ts';
import {
  assessmentDisclosure,
  evaluateDesignAssessment,
  type EvaluatedAssessment,
} from '../shared/assessment.ts';
import { visualReviewDisclosure, type EvaluatedVisualReview } from '../shared/visual-review.ts';
import {
  type PreservationAssertion,
  type PreservationResult,
  type EditScopeReview,
} from '../shared/preservation.ts';
import type { Scene } from '../shared/model.ts';
import type { AgentResult } from './agent.ts';
import { sceneFingerprint } from './render-service.ts';

export type RefinementReviewState = {
  reply: string;
  needsConfirmation: boolean;
  assessment?: EvaluatedAssessment;
  visualReview?: EvaluatedVisualReview;
  editScopeReview?: EditScopeReview;
  reviewDisclosures?: string[];
  assessmentBaselines?: Record<string, Scene>;
  reviewBaseline?: Scene;
  preservationResults?: PreservationResult[];
  preservationEntries?: PreservationEntry[];
};

export type PreservationEntry = { check: PreservationAssertion; baseline: Scene };

/** The first request's baseline wins when a later request repeats its check. */
export function preservationEntries(
  source: RefinementReviewState | undefined,
  checks: PreservationAssertion[] | undefined,
  baseline: Scene,
): PreservationEntry[] {
  return [
    ...new Map(
      [
        ...(source?.preservationEntries || []),
        ...(checks || []).map((check) => ({ check, baseline })),
      ]
        .reverse()
        .map((entry) => [canonical(entry.check), structuredClone(entry)]),
    ).values(),
  ];
}

/** The refinement can repair an old check, but cannot erase it by supplying a new checklist. */
export function carryRefinementReview(
  source: RefinementReviewState,
  answer: AgentResult,
  savedBaseline: Scene,
  candidateBaseline: Scene,
): { answer: AgentResult & { reviewDisclosures?: string[] }; baselines: Record<string, Scene> } {
  if (!answer.scene) return { answer, baselines: source.assessmentBaselines || {} };
  const scene = answer.scene;
  const baselines = { ...source.assessmentBaselines };
  const requirements = (answer.assessment?.requirements || []).map((requirement) =>
    structuredClone(requirement),
  );
  for (const previous of source.assessment?.requirements || []) {
    const index = requirements.findIndex((item) => item.id === previous.id);
    const replacement = index >= 0 ? requirements[index] : undefined;
    const checks = [
      ...new Map(
        [...previous.checks, ...(replacement?.checks || [])].map((check) => [
          canonical(check),
          check,
        ]),
      ).values(),
    ];
    const retained = {
      ...(replacement || previous),
      request: previous.request,
      priority:
        previous.priority === 'required'
          ? ('required' as const)
          : replacement?.priority || previous.priority,
      checks,
    };
    const baseline = baselines[previous.id] || source.reviewBaseline || savedBaseline;
    const evaluated = evaluateDesignAssessment(
      scene,
      { requirements: [retained], assumptions: [] },
      baseline,
    ).requirements[0];
    // A formerly failed objective check can be repaired without repeating its old prose.
    if (
      !replacement &&
      previous.results.some((result) => !result.passed) &&
      evaluated.results.length &&
      evaluated.results.every((result) => result.passed)
    ) {
      retained.status = 'fulfilled';
      retained.evidence = 'The inherited geometry checks now pass on the refined design.';
      retained.limitation = undefined;
    }
    if (index >= 0) requirements[index] = retained;
    else requirements.push(retained);
    baselines[previous.id] = baseline;
  }
  if (source.editScopeReview && !source.editScopeReview.preserved) {
    const id = `scope-${createHash('sha256').update(canonical(source.editScopeReview.selection)).digest('hex').slice(0, 12)}`;
    if (!requirements.some((item) => item.id === id))
      requirements.push({
        id,
        request: 'Preserve the original request scope outside the selected part.',
        priority: 'required',
        status: 'fulfilled',
        evidence: 'Rechecked the original scope against its original baseline.',
        checks: [
          { kind: 'unchanged_except_selection', selection: source.editScopeReview.selection },
        ],
        verification: 'geometry',
        results: [],
      });
    baselines[id] ||= source.reviewBaseline || savedBaseline;
  }
  for (const entry of source.preservationEntries || []) {
    const id = `preserve-${createHash('sha256').update(canonical(entry.check)).digest('hex').slice(0, 12)}`;
    // This immutable context assertion is independent of a model-authored checklist.
    const requirement = {
      id,
      request: 'Preserve the original request constraint.',
      priority: 'required' as const,
      status: 'fulfilled' as const,
      evidence: 'Rechecked against the original request baseline.',
      checks: [entry.check],
      verification: 'geometry' as const,
      results: [],
    };
    const index = requirements.findIndex((item) => item.id === id);
    if (index >= 0) requirements[index] = requirement;
    else requirements.push(requirement);
    baselines[id] = entry.baseline;
  }
  if (requirements.length > 12 || requirements.some((item) => item.checks.length > 8))
    throw new Error(
      'The combined refinement checklist exceeds the bounded review limit. Retain original IDs and refine a smaller request.',
    );
  for (const requirement of requirements) baselines[requirement.id] ||= candidateBaseline;
  const assumptions = [
    ...new Map(
      [
        ...structuredClone(source.assessment?.assumptions || []),
        ...structuredClone(answer.assessment?.assumptions || []),
      ].map((item) => [item.description, item]),
    ).values(),
  ];
  for (const previous of source.assessment?.assumptions || [])
    if (previous.requiresConfirmation) {
      const current = assumptions.find((item) => item.description === previous.description)!;
      current.requiresConfirmation = true;
    }
  if (assumptions.length > 8)
    throw new Error('The combined refinement assumptions exceed the bounded review limit.');
  const assessment: EvaluatedAssessment | undefined = requirements.length
    ? {
        requirements: requirements.map(
          (requirement) =>
            evaluateDesignAssessment(
              scene,
              { requirements: [requirement], assumptions: [] },
              baselines[requirement.id],
            ).requirements[0],
        ),
        assumptions,
        requiresConfirmation: false,
      }
    : undefined;
  if (assessment)
    assessment.requiresConfirmation =
      assessment.requirements.some(
        (item) => item.priority === 'required' && item.status !== 'fulfilled',
      ) || assumptions.some((item) => item.requiresConfirmation);
  let visualReview = answer.visualReview;
  const oldVisual = source.visualReview;
  if (oldVisual?.requiresConfirmation) {
    const replacement = visualReview;
    const replaces =
      replacement?.status === 'passed' &&
      replacement.captures.length &&
      replacement.captures.every((capture) => capture.sceneHash === sceneFingerprint(scene)) &&
      oldVisual.captures.every((previous) =>
        replacement.captures.some(
          (capture) =>
            capture.quality === 'live' &&
            capture.view === previous.view &&
            (!capture.roomId || capture.roomId === previous.roomId) &&
            (previous.view !== 'interior' || capture.angle === previous.angle),
        ),
      );
    if (!replaces)
      visualReview = {
        ...oldVisual,
        limitations: [
          ...new Set([
            ...oldVisual.limitations,
            'An earlier visual concern has not been replaced by an equivalent fresh passing review.',
          ]),
        ],
        requiresConfirmation: true,
      };
  }
  const retained = [...(source.reviewDisclosures || [])];
  // Legacy/injected results without typed assertions cannot safely be declared repaired.
  if (!source.preservationEntries?.length)
    for (const result of source.preservationResults || [])
      if (!result.passed)
        retained.push(`Earlier preservation constraint remains unverified: ${result.reason}`);
  const explained =
    (source.preservationEntries?.length &&
      source.preservationResults?.some((result) => !result.passed)) ||
    source.assessment?.requiresConfirmation ||
    source.visualReview?.requiresConfirmation ||
    (source.editScopeReview && !source.editScopeReview.preserved);
  if (source.needsConfirmation && !explained && !source.reviewDisclosures?.length)
    retained.push(`Earlier proposal for review: ${source.reply}`);
  const reviewDisclosures = [...new Set(retained)];
  const disclosure = [
    assessment ? assessmentDisclosure(assessment) : '',
    visualReview ? visualReviewDisclosure(visualReview) : '',
    ...reviewDisclosures,
  ]
    .filter(Boolean)
    .filter((text) => !answer.reply.includes(text));
  return {
    baselines,
    answer: {
      ...answer,
      ...(assessment ? { assessment } : {}),
      ...(visualReview ? { visualReview } : {}),
      reviewDisclosures,
      reply: [answer.reply, ...disclosure].join('\n\n'),
      needsConfirmation:
        answer.needsConfirmation ||
        !!assessment?.requiresConfirmation ||
        !!visualReview?.requiresConfirmation ||
        reviewDisclosures.length > 0,
    },
  };
}

/** Original preservation facts are model input, distinct from the current candidate. */
export function inheritedPreservationContext(source?: RefinementReviewState) {
  const groups = new Map<string, { checks: PreservationAssertion[]; baseline: Scene }>();
  for (const entry of source?.preservationEntries || []) {
    const id = sceneFingerprint(entry.baseline);
    const group = groups.get(id) || { checks: [], baseline: entry.baseline };
    group.checks.push(entry.check);
    groups.set(id, group);
  }
  return [...groups].map(([baselineHash, { checks, baseline }]) => {
    const wholeScene = checks.some((check) => check.kind === 'unchanged_except_selection');
    const ids = new Set(checks.flatMap((check) => ('roomId' in check ? [check.roomId] : [])));
    return {
      baselineHash,
      checks,
      originalBaseline: wholeScene
        ? baseline
        : { ...baseline, rooms: baseline.rooms.filter((room) => ids.has(room.id)) },
      description: wholeScene
        ? 'Immutable original house baseline; compare outside the selected part.'
        : 'Immutable original baseline projection: only checked rooms are included; omitted rooms were not removed. Global context resolves inherited roof and material choices.',
    };
  });
}

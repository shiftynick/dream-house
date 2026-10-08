import type { Scene } from './model.ts';
import type { DesignIssue } from './design.ts';
import type { EvaluatedAssessment } from './assessment.ts';
import type { EvaluatedVisualReview } from './visual-review.ts';
import type { AgentUsage, HarnessResult } from './harness.ts';

export type VisualAlternative = {
  id: string;
  name: string;
  description: string;
  scene: Scene;
  thumbnail: string;
  issues: DesignIssue[];
  changes: string[];
  parentOptionId?: string;
  needsConfirmation?: boolean;
  reviewDisclosures?: string[];
  assessment?: EvaluatedAssessment;
  visualReview?: EvaluatedVisualReview;
  editScopeReview?: HarnessResult['editScopeReview'];
  preservationResults?: HarnessResult['preservationResults'];
};
export type AlternativeResult = {
  choiceSetId: string;
  projectId: string;
  baseRevision: number;
  options: VisualAlternative[];
  usage: AgentUsage;
};

export type AlternativeRefinementResult = HarnessResult & {
  choices?: AlternativeResult;
  refinedOptionId?: string;
};

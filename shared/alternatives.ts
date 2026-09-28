import type { Scene } from './model.ts';
import type { DesignIssue } from './design.ts';
import type { AgentUsage } from './harness.ts';

export type VisualAlternative = {
  id: string;
  name: string;
  description: string;
  scene: Scene;
  thumbnail: string;
  issues: DesignIssue[];
  changes: string[];
};
export type AlternativeResult = {
  choiceSetId: string;
  projectId: string;
  baseRevision: number;
  options: VisualAlternative[];
  usage: AgentUsage;
};

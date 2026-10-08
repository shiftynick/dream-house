import { z } from 'zod';
import type { EvaluatedVisualReview, VisualCaptureProvenance } from './visual-review.ts';
import type { Scene, Project } from './model.ts';
import type { DesignIssue } from './design.ts';
import { designSelectionSchema } from './selection.ts';
import type { EvaluatedAssessment } from './assessment.ts';
import {
  preservationAssertionSchema,
  type EditScopeReview,
  type PreservationResult,
} from './preservation.ts';

const vector = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
export const agentContextSchema = z.object({
  selectedRoomId: z.string().max(60).nullable().optional(),
  selection: designSelectionSchema.nullable().optional(),
  // Per-request scope: edits outside this selected part require explicit review.
  editScope: designSelectionSchema.optional(),
  preservationChecks: z.array(preservationAssertionSchema).max(12).optional(),
  renderClientId: z.string().uuid().optional(),
  allowVisualReview: z.boolean().optional(),
  view: z.enum(['orbit', 'walk', 'plan']).optional(),
  camera: z.object({ position: vector, target: vector }).optional(),
  // Captured only from the local house viewport, never from the desktop.
  image: z
    .string()
    .max(1_000_000)
    .regex(/^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/)
    .optional(),
});
export type AgentContext = z.infer<typeof agentContextSchema>;
export type RunStage =
  | 'starting'
  | 'thinking'
  | 'inspecting'
  | 'editing'
  | 'checking'
  | 'repairing'
  | 'rendering'
  | 'ready'
  | 'complete'
  | 'failed'
  | 'cancelled';
export type RunEvent = {
  stage: RunStage;
  message: string;
  at: string;
  tool?: string;
  issues?: DesignIssue[];
  changes?: string[];
  render?: VisualCaptureProvenance;
};
export type AgentUsage = {
  inputTokens: number;
  outputTokens: number;
  cost: number | null;
  calls: number;
};
export type RunMetrics = {
  elapsedMs: number;
  modelMs: number;
  toolMs: number;
  renderMs: number;
  toolCalls: number;
  captures: number;
  reusedCaptures: number;
  contextCharacters: number;
  compactedCharacters: number;
  imageBytesSent: number;
};
export type HarnessResult = {
  runId: string;
  baseRevision: number;
  draftId?: string;
  reply: string;
  scene: Scene | null;
  needsConfirmation: boolean;
  issues: DesignIssue[];
  changes: string[];
  events: RunEvent[];
  usage: AgentUsage;
  metrics?: RunMetrics;
  assessment?: EvaluatedAssessment;
  visualReview?: EvaluatedVisualReview;
  editScopeReview?: EditScopeReview;
  preservationResults?: PreservationResult[];
};
export type RunStatus = {
  id: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  stage: RunStage;
  message: string;
  events: RunEvent[];
  preview: Scene | null;
  issues: DesignIssue[];
  changes: string[];
  error?: string;
};
export type DraftCommitResult = {
  project: Project;
  reply: string;
  changes: string[];
  issues: DesignIssue[];
};

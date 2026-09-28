import { z } from 'zod';
import type { Scene, Project } from './model.ts';
import type { DesignIssue } from './design.ts';

const vector = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
export const agentContextSchema = z.object({
  selectedRoomId: z.string().max(60).nullable().optional(),
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
};
export type AgentUsage = {
  inputTokens: number;
  outputTokens: number;
  cost: number | null;
  calls: number;
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

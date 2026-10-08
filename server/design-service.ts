import {
  carryRefinementReview,
  preservationEntries,
  type RefinementReviewState,
} from './refinement-review.ts';
import type { AgentResult } from './agent.ts';
import { randomUUID } from 'node:crypto';
import { DesignDraft, canonical, canonicalScene, describeChanges } from '../shared/draft.ts';
import { validateDesignChange } from '../shared/design.ts';
import { editProject, type Scene } from '../shared/model.ts';
import type { AgentContext, DraftCommitResult } from '../shared/harness.ts';
import { ProjectStore, RevisionConflict } from './storage.ts';

export class DesignServiceError extends Error {
  constructor(
    message: string,
    public status = 422,
    public code?: string,
  ) {
    super(message);
    this.name = 'DesignServiceError';
  }
}
export type StoredDraft = RefinementReviewState & {
  id: string;
  projectId?: string;
  baseRevision: number;
  draft: DesignDraft;
  savedOriginal: Scene;
  parentDraftId?: string;
  refinement?: boolean;
  createdAt: number;
  reply: string;
  needsConfirmation: boolean;
  ready: boolean;
};

/** Reusable application service. All adapters share these commit rules. */
export class DesignService {
  private drafts = new Map<string, StoredDraft>();
  private commits = new Map<string, Promise<DraftCommitResult>>();
  constructor(private store: ProjectStore) {}
  async create(
    expectedRevision: number,
    expectedScene?: Scene,
    expectedProjectId?: string,
  ): Promise<StoredDraft> {
    this.prune();
    const project = await this.store.read();
    if (
      project.revision !== expectedRevision ||
      (expectedProjectId !== undefined && project.projectId !== expectedProjectId) ||
      (expectedScene && canonicalScene(expectedScene) !== canonicalScene(project.scene))
    )
      throw new RevisionConflict();
    if (this.drafts.size >= 32)
      throw new DesignServiceError(
        'Too many open design drafts. Discard a proposal before starting another.',
        429,
      );
    const draft: StoredDraft = {
      id: randomUUID(),
      projectId: project.projectId,
      baseRevision: project.revision,
      draft: new DesignDraft(project.scene),
      savedOriginal: structuredClone(project.scene),
      createdAt: Date.now(),
      reply: '',
      needsConfirmation: false,
      ready: false,
    };
    this.drafts.set(draft.id, draft);
    return draft;
  }
  async createFromCandidate(
    expectedRevision: number,
    projectId: string,
    candidate: Scene,
    savedOriginal: Scene,
    parentDraftId?: string,
  ): Promise<StoredDraft> {
    const entry = await this.create(expectedRevision, savedOriginal, projectId);
    const issues = validateDesignChange(savedOriginal, candidate);
    if (issues.some((issue) => issue.severity === 'error')) {
      this.discard(entry.id);
      throw new DesignServiceError('The proposal no longer passes the saved house design checks.');
    }
    entry.draft = new DesignDraft(candidate);
    entry.parentDraftId = parentDraftId;
    entry.refinement = true;
    entry.reviewBaseline = structuredClone(candidate);
    entry.needsConfirmation = true;
    return entry;
  }
  async refine(id: string, expectedRevision: number, projectId: string): Promise<StoredDraft> {
    const source = this.get(id);
    if (!source.ready || this.commits.has(id))
      throw new DesignServiceError('This proposal is not available for refinement.', 409);
    if (source.projectId !== projectId) throw new RevisionConflict();
    const entry = await this.createFromCandidate(
      expectedRevision,
      projectId,
      source.draft.scene,
      source.savedOriginal,
      id,
    );
    entry.assessment = structuredClone(source.assessment);
    entry.visualReview = structuredClone(source.visualReview);
    entry.editScopeReview = structuredClone(source.editScopeReview);
    entry.assessmentBaselines = structuredClone(source.assessmentBaselines);
    entry.reviewDisclosures = structuredClone(source.reviewDisclosures);
    return entry;
  }
  get(id: string): StoredDraft {
    this.prune();
    const draft = this.drafts.get(id);
    if (!draft)
      throw new DesignServiceError(
        'This design draft expired or was discarded. Please ask for the change again.',
        404,
      );
    return draft;
  }
  complete(id: string, answer: AgentResult, context?: AgentContext) {
    const entry = this.get(id);
    const source = entry.parentDraftId ? this.get(entry.parentDraftId) : undefined;
    const carried = source
      ? carryRefinementReview(source, answer, entry.savedOriginal, entry.draft.original)
      : {
          answer: { ...answer, reviewDisclosures: undefined as string[] | undefined },
          baselines: Object.fromEntries(
            (answer.assessment?.requirements || []).map((requirement) => [
              requirement.id,
              entry.draft.original,
            ]),
          ),
        };
    entry.preservationEntries = preservationEntries(
      source,
      context?.preservationChecks,
      entry.draft.original,
    );
    entry.preservationResults = carried.answer.preservationResults;
    entry.assessment = carried.answer.assessment;
    entry.visualReview = carried.answer.visualReview;
    entry.editScopeReview = carried.answer.editScopeReview;
    entry.reviewDisclosures = carried.answer.reviewDisclosures;
    entry.assessmentBaselines = carried.baselines;
    entry.reviewBaseline = entry.draft.original;
    entry.reply = carried.answer.reply;
    entry.needsConfirmation = !!entry.refinement || carried.answer.needsConfirmation;
    entry.ready = !!carried.answer.scene;
    return carried.answer;
  }
  private issues(entry: StoredDraft) {
    const issues = [
      ...entry.draft.issues,
      ...validateDesignChange(entry.savedOriginal, entry.draft.scene),
    ];
    return [...new Map(issues.map((issue) => [canonical(issue), issue])).values()];
  }
  describe(id: string) {
    const entry = this.get(id);
    return {
      id: entry.id,
      baseRevision: entry.baseRevision,
      projectId: entry.projectId,
      scene: entry.draft.scene,
      issues: this.issues(entry),
      changes: describeChanges(entry.savedOriginal, entry.draft.scene),
      parentDraftId: entry.parentDraftId,
      needsConfirmation: entry.needsConfirmation || entry.draft.needsConfirmation,
      ready: entry.ready,
    };
  }
  apply(id: string, operations: unknown) {
    const entry = this.get(id);
    if (this.commits.has(id))
      throw new DesignServiceError('This draft is already being applied.', 409);
    const result = entry.draft.apply(operations);
    entry.ready = !this.issues(entry).some((issue) => issue.severity === 'error');
    entry.needsConfirmation = !!entry.refinement || entry.draft.needsConfirmation;
    entry.reply = result.changes.length
      ? result.changes.slice(0, 6).join(' ')
      : 'No changes were needed.';
    return this.describe(id);
  }
  discard(id: string) {
    if (this.commits.has(id))
      throw new DesignServiceError('This draft is already being applied.', 409);
    this.drafts.delete(id);
  }
  async commit(id: string, expectedRevision: number, confirm: boolean): Promise<DraftCommitResult> {
    const previous = this.commits.get(id);
    if (previous) {
      const result = await previous;
      const project = await this.store.read();
      if (project.projectId !== result.project.projectId) throw new RevisionConflict();
      return { ...result, project };
    }
    const entry = this.get(id);
    const finalIssues = this.issues(entry);
    if (!entry.ready || finalIssues.some((i) => i.severity === 'error'))
      throw new DesignServiceError(
        'This draft has unresolved design issues and cannot be applied.',
      );
    if ((entry.needsConfirmation || entry.draft.needsConfirmation) && !confirm)
      throw new DesignServiceError(
        'This change needs your confirmation before it can be applied.',
        409,
      );
    const scene = entry.draft.scene;
    const changes = describeChanges(entry.savedOriginal, scene);
    const issues = finalIssues;
    const reply = entry.reply || changes.slice(0, 6).join(' ') || 'No changes were needed.';
    const operation = this.store
      .update(
        expectedRevision,
        (current) => {
          if (canonicalScene(current.scene) !== canonicalScene(entry.savedOriginal))
            throw new RevisionConflict();
          const next =
            canonicalScene(entry.savedOriginal) !== canonicalScene(scene)
              ? editProject(current, scene)
              : current;
          return {
            ...next,
            messages: [
              ...next.messages,
              { id: `design-${id}`, role: 'assistant' as const, text: reply },
            ].slice(-100),
          };
        },
        entry.projectId,
      )
      .then((project) => {
        this.drafts.delete(id);
        return { project, reply, changes, issues };
      })
      .catch((error) => {
        this.commits.delete(id);
        throw error;
      });
    this.commits.set(id, operation);
    if (this.commits.size > 64) this.commits.delete(this.commits.keys().next().value!);
    return operation;
  }
  private prune() {
    const cutoff = Date.now() - 30 * 60_000;
    for (const [id, draft] of this.drafts)
      if (draft.createdAt < cutoff && !this.commits.has(id)) this.drafts.delete(id);
  }
}

import { randomUUID } from 'node:crypto';
import { DesignDraft, canonicalScene } from '../shared/draft.ts';
import { editProject, type Scene } from '../shared/model.ts';
import type { DraftCommitResult } from '../shared/harness.ts';
import { ProjectStore, RevisionConflict } from './storage.ts';

export class DesignServiceError extends Error {
  constructor(
    message: string,
    public status = 422,
  ) {
    super(message);
    this.name = 'DesignServiceError';
  }
}
export type StoredDraft = {
  id: string;
  baseRevision: number;
  draft: DesignDraft;
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
  async create(expectedRevision: number, expectedScene?: Scene): Promise<StoredDraft> {
    this.prune();
    const project = await this.store.read();
    if (
      project.revision !== expectedRevision ||
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
      baseRevision: project.revision,
      draft: new DesignDraft(project.scene),
      createdAt: Date.now(),
      reply: '',
      needsConfirmation: false,
      ready: false,
    };
    this.drafts.set(draft.id, draft);
    return draft;
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
  describe(id: string) {
    const entry = this.get(id);
    return {
      id: entry.id,
      baseRevision: entry.baseRevision,
      scene: entry.draft.scene,
      issues: entry.draft.issues,
      changes: entry.draft.changes,
      needsConfirmation: entry.needsConfirmation || entry.draft.needsConfirmation,
      ready: entry.ready,
    };
  }
  apply(id: string, operations: unknown) {
    const entry = this.get(id);
    if (this.commits.has(id))
      throw new DesignServiceError('This draft is already being applied.', 409);
    const result = entry.draft.apply(operations);
    entry.ready = !result.issues.some((i) => i.severity === 'error');
    entry.needsConfirmation = entry.draft.needsConfirmation;
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
      return { ...result, project: await this.store.read() };
    }
    const entry = this.get(id);
    if (!entry.ready || entry.draft.issues.some((i) => i.severity === 'error'))
      throw new DesignServiceError(
        'This draft has unresolved design issues and cannot be applied.',
      );
    if ((entry.needsConfirmation || entry.draft.needsConfirmation) && !confirm)
      throw new DesignServiceError(
        'This change needs your confirmation before it can be applied.',
        409,
      );
    const scene = entry.draft.scene;
    const changes = entry.draft.changes;
    const issues = entry.draft.issues;
    const reply = entry.reply || changes.slice(0, 6).join(' ') || 'No changes were needed.';
    const operation = this.store
      .update(expectedRevision, (current) => {
        if (canonicalScene(current.scene) !== canonicalScene(entry.draft.original))
          throw new RevisionConflict();
        const next = entry.draft.changed ? editProject(current, scene) : current;
        return {
          ...next,
          messages: [
            ...next.messages,
            { id: `design-${id}`, role: 'assistant' as const, text: reply },
          ].slice(-100),
        };
      })
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

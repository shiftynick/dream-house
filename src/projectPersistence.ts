import { documentSchema, type Project } from '../shared/model';
import { ApiError } from './api';

export type SaveState = 'saving' | 'saved' | 'error' | 'conflict';
export type ProjectAction = Project | null | ((current: Project | null) => Project | null);

/** One writer per browser tab, using server revisions to detect other writers. */
export class ProjectPersistence {
  project: Project | null = null;
  state: SaveState = 'saved';
  private revision = 0;
  private changed = 0;
  private acknowledged = 0;
  private saving: Promise<Project | null> | null = null;

  constructor(
    private write: (project: Project) => Promise<Project>,
    private onChange: (project: Project | null, state: SaveState) => void,
    private onError: (message: string) => void,
  ) {}

  get unsaved() {
    return this.acknowledged < this.changed;
  }

  private publish(state = this.state) {
    this.state = state;
    this.onChange(this.project, this.state);
  }

  acceptPersisted(incoming: Project) {
    if (this.saving)
      throw new Error('Wait for local saving to finish before replacing the project.');
    this.project = documentSchema.parse(incoming);
    this.revision = this.project.revision;
    this.acknowledged = this.changed;
    this.publish('saved');
  }

  edit(action: ProjectAction) {
    const proposed = typeof action === 'function' ? action(this.project) : action;
    if (proposed === this.project) return false;
    this.project = proposed
      ? {
          ...proposed,
          revision: this.revision,
          // Importing a document edits the active house; switching is acceptPersisted only.
          projectId: this.project?.projectId ?? proposed.projectId,
          projectName: this.project?.projectName ?? proposed.projectName,
        }
      : null;
    this.changed++;
    this.publish(this.state === 'conflict' ? 'conflict' : 'saving');
    return true;
  }

  markConflict() {
    this.publish('conflict');
    this.onError(
      'This project changed in another session. Export your local work, then reload the saved project.',
    );
  }

  flush(): Promise<Project | null> {
    if (this.state === 'conflict')
      return Promise.reject(
        new Error('This project changed elsewhere. Reload the saved project before continuing.'),
      );
    if (this.saving) return this.saving;
    const work = async () => {
      try {
        while (this.project && this.unsaved) {
          const generation = this.changed;
          const snapshot = { ...this.project, revision: this.revision };
          this.publish('saving');
          const stored = documentSchema.parse(await this.write(snapshot));
          if (snapshot.projectId && stored.projectId !== snapshot.projectId)
            throw new Error(
              'The saved response belongs to a different house. Reload before continuing.',
            );
          this.revision = stored.revision;
          this.acknowledged = generation;
          // A response from an earlier edit must never replace a newer local edit.
          this.project =
            generation === this.changed ? stored : { ...this.project!, revision: stored.revision };
          this.publish();
        }
        this.publish('saved');
        return this.project;
      } catch (error) {
        const conflict = error instanceof ApiError && error.status === 409;
        this.publish(conflict ? 'conflict' : 'error');
        this.onError(
          conflict
            ? 'This project changed in another session. Export your local work, then reload the saved project.'
            : `Could not save: ${(error as Error).message}`,
        );
        throw error;
      }
    };
    this.saving = work().finally(() => {
      this.saving = null;
    });
    return this.saving;
  }
}

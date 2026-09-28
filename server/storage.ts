import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { documentSchema, newProject, validateScene, type Project } from '../shared/model.ts';

export class RevisionConflict extends Error {
  constructor() {
    super(
      'This project changed after it was loaded. Reload the latest house before applying this change.',
    );
    this.name = 'RevisionConflict';
  }
}

function parseProject(input: unknown): Project {
  const project = documentSchema.parse(input);
  [
    project.scene,
    ...project.past,
    ...project.future,
    ...project.variants.map((v) => v.scene),
  ].forEach(validateScene);
  return project;
}

/** The single atomic project writer used by HTTP and future control adapters. */
export class ProjectStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(public directory: string) {}
  private async readDisk(): Promise<Project> {
    try {
      return parseProject(
        JSON.parse(await readFile(path.join(this.directory, 'project.json'), 'utf8')),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return newProject();
      throw error;
    }
  }
  async read(): Promise<Project> {
    await this.queue.catch(() => {});
    return this.readDisk();
  }
  save(input: unknown, expectedRevision?: number): Promise<Project> {
    const project = parseProject(input);
    return this.update(expectedRevision, () => project);
  }
  update(
    expectedRevision: number | undefined,
    change: (current: Project) => Project,
  ): Promise<Project> {
    const task = this.queue
      .catch(() => {})
      .then(async () => {
        const current = await this.readDisk();
        if (expectedRevision !== undefined && expectedRevision !== current.revision)
          throw new RevisionConflict();
        const project = parseProject(change(structuredClone(current)));
        project.revision = current.revision + 1;
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const file = path.join(this.directory, 'project.json');
        await writeFile(file + '.tmp', JSON.stringify(project, null, 2), { mode: 0o600 });
        await rename(file + '.tmp', file);
        return project;
      });
    this.queue = task;
    return task;
  }
}

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { documentSchema, newProject, validateScene, type Project } from '../shared/model.ts';

export class ProjectStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(public directory: string) {}
  async read(): Promise<Project> {
    try {
      const project = documentSchema.parse(
        JSON.parse(await readFile(path.join(this.directory, 'project.json'), 'utf8')),
      );
      [
        project.scene,
        ...project.past,
        ...project.future,
        ...project.variants.map((v) => v.scene),
      ].forEach(validateScene);
      return project;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return newProject();
      throw error;
    }
  }
  save(input: unknown): Promise<void> {
    const project = documentSchema.parse(input);
    [
      project.scene,
      ...project.past,
      ...project.future,
      ...project.variants.map((v) => v.scene),
    ].forEach(validateScene);
    const task = this.queue
      .catch(() => {})
      .then(async () => {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const file = path.join(this.directory, 'project.json');
        await writeFile(file + '.tmp', JSON.stringify(project, null, 2), { mode: 0o600 });
        await rename(file + '.tmp', file);
      });
    this.queue = task;
    return task;
  }
}

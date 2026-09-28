import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
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

const workspaceSchema = z.object({
  version: z.literal(1),
  activeProjectId: z.string(),
  projects: z.array(documentSchema).min(1).max(100),
});
type Workspace = z.infer<typeof workspaceSchema>;

/** The single atomic project writer used by HTTP and future control adapters. */
export class ProjectStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(public directory: string) {}
  private async readWorkspace(): Promise<Workspace> {
    try {
      const workspace = workspaceSchema.parse(
        JSON.parse(await readFile(path.join(this.directory, 'workspace.json'), 'utf8')),
      );
      workspace.projects.forEach(parseProject);
      const ids = workspace.projects.map((p) => p.projectId);
      if (
        ids.some((id) => !id) ||
        new Set(ids).size !== ids.length ||
        !ids.includes(workspace.activeProjectId)
      )
        throw new Error('The local project library has inconsistent project IDs.');
      return workspace;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    let legacy: Project;
    try {
      legacy = parseProject(
        JSON.parse(await readFile(path.join(this.directory, 'project.json'), 'utf8')),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      legacy = newProject();
    }
    // Lazy migration: the original file is retained as a backup, and merely reading
    // a legacy project never changes it. The first write creates the library.
    const project = {
      ...legacy,
      projectId: legacy.projectId || 'original',
      projectName: legacy.projectName || legacy.scene.name,
    };
    return { version: 1, activeProjectId: project.projectId, projects: [project] };
  }
  private active(workspace: Workspace): Project {
    return workspace.projects.find((p) => p.projectId === workspace.activeProjectId)!;
  }
  private async writeWorkspace(workspace: Workspace) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, 'workspace.json');
    await writeFile(file + '.tmp', JSON.stringify(workspace, null, 2), { mode: 0o600 });
    await rename(file + '.tmp', file);
  }
  async read(): Promise<Project> {
    await this.queue.catch(() => {});
    return this.active(await this.readWorkspace());
  }
  save(input: unknown, expectedRevision?: number): Promise<Project> {
    const project = parseProject(input);
    return this.update(expectedRevision, () => project, project.projectId);
  }
  update(
    expectedRevision: number | undefined,
    change: (current: Project) => Project,
    expectedProjectId?: string,
  ): Promise<Project> {
    const task = this.queue
      .catch(() => {})
      .then(async () => {
        const workspace = await this.readWorkspace();
        const current = this.active(workspace);
        if (
          (expectedRevision !== undefined && expectedRevision !== current.revision) ||
          (expectedProjectId !== undefined && expectedProjectId !== current.projectId)
        )
          throw new RevisionConflict();
        const project = parseProject(change(structuredClone(current)));
        if (project.projectId && project.projectId !== current.projectId)
          throw new RevisionConflict();
        project.projectId = current.projectId;
        project.projectName ||= current.projectName || project.scene.name;
        project.revision = current.revision + 1;
        workspace.projects[workspace.projects.findIndex((p) => p.projectId === current.projectId)] =
          project;
        await this.writeWorkspace(workspace);
        return project;
      });
    this.queue = task;
    return task;
  }

  async list() {
    await this.queue.catch(() => {});
    const workspace = await this.readWorkspace();
    return {
      activeProjectId: workspace.activeProjectId,
      projects: workspace.projects.map((p) => ({
        id: p.projectId!,
        name: p.projectName || p.scene.name,
        rooms: p.scene.rooms.length,
        revision: p.revision,
      })),
    };
  }

  private switchProject(
    expectedProjectId: string,
    expectedRevision: number,
    select: (workspace: Workspace) => Project,
  ): Promise<Project> {
    const task = this.queue
      .catch(() => {})
      .then(async () => {
        const workspace = await this.readWorkspace();
        const current = this.active(workspace);
        if (current.projectId !== expectedProjectId || current.revision !== expectedRevision)
          throw new RevisionConflict();
        const project = select(workspace);
        workspace.activeProjectId = project.projectId!;
        await this.writeWorkspace(workspace);
        return structuredClone(project);
      });
    this.queue = task;
    return task;
  }

  createProject(name: string, expectedProjectId: string, expectedRevision: number) {
    const validName = z.string().trim().min(1).max(100).parse(name);
    return this.switchProject(expectedProjectId, expectedRevision, (workspace) => {
      if (workspace.projects.length >= 100)
        throw new Error('The project library has reached its 100-house limit.');
      const project = { ...newProject(), projectId: randomUUID(), projectName: validName };
      project.scene.name = validName;
      workspace.projects.push(project);
      return project;
    });
  }

  openProject(id: string, expectedProjectId: string, expectedRevision: number) {
    return this.switchProject(expectedProjectId, expectedRevision, (workspace) => {
      const project = workspace.projects.find((p) => p.projectId === id);
      if (!project) throw new Error('This house is no longer in the project library.');
      return project;
    });
  }
}

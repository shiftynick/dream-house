import { randomUUID } from 'node:crypto';
import { canonicalScene, canonical } from '../shared/draft.ts';
import { editProject, type Project, type Scene, type Room } from '../shared/model.ts';
import { validateDesignChange } from '../shared/design.ts';
import { renderCameraForScenes, renderRequestSchema } from '../shared/render.ts';
import type { AlternativeResult, VisualAlternative } from '../shared/alternatives.ts';
import type { AgentResult } from './agent.ts';
import { DesignServiceError } from './design-service.ts';
import { ProjectStore, RevisionConflict } from './storage.ts';
import { type RenderProvider, validateCapture } from './render-service.ts';

type ChoiceSet = { result: AlternativeResult; original: Scene; prompt: string; createdAt: number };
function visualSignature(scene: Scene) {
  // Names/brief-only changes do not make a visibly different alternative.
  const sorted = (items: unknown[]) => items.map(canonical).sort();
  const renderedRoom = ({ id, name, palette, surfacePalettes, ...room }: Room) => ({
    ...room,
    palette: palette ?? scene.palette,
    surfaces: Object.fromEntries(
      (['north', 'south', 'east', 'west', 'floor', 'roof'] as const).map((surface) => [
        surface,
        surfacePalettes?.[surface] ?? palette ?? scene.palette,
      ]),
    ),
  });
  const geometry = (id: string) => {
    const room = scene.rooms.find((r) => r.id === id);
    if (!room) return null;
    return renderedRoom(room);
  };
  return canonical({
    palette: scene.palette,
    roof: scene.roof,
    slope: scene.slope,
    rooms: sorted(scene.rooms.map(renderedRoom)),
    stairs: sorted(scene.stairs.map(({ id, ...stair }) => stair)),
    fireplace: scene.fireplace,
    connections: sorted(
      (scene.design?.connections || []).map(({ id, roomAId, roomBId, ...connection }) => ({
        ...connection,
        roomA: geometry(roomAId),
        roomB: geometry(roomBId),
      })),
    ),
    stairLinks: sorted(
      (scene.design?.stairLinks || []).map((link) => {
        const stair = scene.stairs.find((s) => s.id === link.stairId);
        return {
          stair: stair ? (({ id, ...rest }) => rest)(stair) : null,
          lower: geometry(link.lowerRoomId),
          upper: geometry(link.upperRoomId),
        };
      }),
    ),
  });
}

/** Choice generation and acceptance share the same invariants in every transport. */
export class AlternativeService {
  private sets = new Map<string, ChoiceSet>();
  private accepted = new Map<string, Promise<Project>>();
  constructor(private store: ProjectStore) {}
  async generate(options: {
    project: Project;
    prompt: string;
    count: number;
    build: (index: number, previous: VisualAlternative[]) => Promise<AgentResult>;
    render: RenderProvider;
    signal?: AbortSignal;
  }): Promise<AlternativeResult> {
    this.prune();
    const { project, prompt, count, signal } = options;
    if (!project.projectId || ![2, 3].includes(count))
      throw new DesignServiceError('Choose two or three alternatives.');
    if (project.variants.length + count > 30)
      throw new DesignServiceError(
        'Remove a saved alternative before generating more; this project can keep 30.',
      );
    const generated: VisualAlternative[] = [];
    const usage = { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 as number | null };
    for (let index = 0; index < count; index++) {
      signal?.throwIfAborted();
      const result = await options.build(index, generated);
      signal?.throwIfAborted();
      if (!result.scene)
        throw new DesignServiceError(
          result.reply || 'Describe what you want to explore before generating alternatives.',
        );
      const issues = validateDesignChange(project.scene, result.scene);
      if (issues.some((i) => i.severity === 'error'))
        throw new DesignServiceError('An alternative failed design checks and was not offered.');
      if (
        visualSignature(project.scene) === visualSignature(result.scene) ||
        generated.some((option) => visualSignature(option.scene) === visualSignature(result.scene!))
      )
        throw new DesignServiceError(
          'The model did not produce distinct visual alternatives. Try specifying different materials or layout directions.',
        );
      generated.push({
        id: randomUUID(),
        name: `Option ${index + 1}`,
        description: result.reply.slice(0, 1000),
        scene: result.scene,
        thumbnail: '',
        issues,
        changes: result.changes,
      });
      usage.calls += result.usage.calls;
      usage.inputTokens += result.usage.inputTokens;
      usage.outputTokens += result.usage.outputTokens;
      usage.cost =
        usage.cost === null || result.usage.cost === null ? null : usage.cost + result.usage.cost;
    }
    // Fit the union once so a larger option is not misleadingly shown at a smaller scale.
    const baseRequest = renderRequestSchema.parse({
      view: 'exterior',
      angle: 'southeast',
      quality: 'live',
      light: 'day',
    });
    const { position, target } = renderCameraForScenes(
      generated.map((option) => option.scene),
      baseRequest,
    );
    for (const option of generated) {
      signal?.throwIfAborted();
      const request = { ...baseRequest, camera: { position, target } };
      const capture = validateCapture(
        option.scene,
        request,
        await options.render(option.scene, request, signal),
      );
      option.thumbnail = capture.image;
      if (option.thumbnail.length > 500_000)
        throw new DesignServiceError(
          'The local preview is too large to save. Try again at a smaller render size.',
        );
    }
    signal?.throwIfAborted();
    const result = {
      choiceSetId: randomUUID(),
      projectId: project.projectId,
      baseRevision: project.revision,
      options: generated,
      usage,
    };
    if (this.sets.size >= 12) this.sets.delete(this.sets.keys().next().value!);
    this.sets.set(result.choiceSetId, {
      result,
      original: structuredClone(project.scene),
      prompt,
      createdAt: Date.now(),
    });
    return result;
  }
  async choose(
    choiceSetId: string,
    optionId: string,
    projectId: string,
    expectedRevision: number,
    preferenceText = '',
  ): Promise<Project> {
    const key = `${choiceSetId}:${optionId}`;
    const old = this.accepted.get(key);
    if (old) {
      const accepted = await old;
      const current = await this.store.read();
      if (current.projectId !== projectId || accepted.projectId !== projectId)
        throw new RevisionConflict();
      return current;
    }
    this.prune();
    const set = this.sets.get(choiceSetId);
    const option = set?.result.options.find((o) => o.id === optionId);
    if (!set || !option)
      throw new DesignServiceError('These alternatives expired. Generate a fresh comparison.', 404);
    if (set.result.projectId !== projectId) throw new RevisionConflict();
    const operation = this.store
      .update(
        expectedRevision,
        (current) => {
          if (canonicalScene(current.scene) !== canonicalScene(set.original))
            throw new DesignServiceError(
              'Your house changed since these alternatives were generated. Generate fresh choices for the current house.',
              409,
              'stale_alternatives',
            );
          if (current.variants.length + set.result.options.length > 30)
            throw new DesignServiceError(
              'There is no room to save these alternatives. Remove an older saved alternative first.',
            );
          const scene = structuredClone(option.scene);
          const requirements = [...(scene.design?.requirements || [])];
          if (requirements.length >= 60) {
            const oldestChoice = requirements.findIndex(
              (r) => r.source === 'preference' && r.id.startsWith('choice-'),
            );
            if (oldestChoice < 0)
              throw new DesignServiceError(
                'The design brief is full. Remove a note before recording this choice.',
              );
            requirements.splice(oldestChoice, 1);
          }
          requirements.push({
            id: `choice-${randomUUID()}`,
            kind: 'intent',
            source: 'preference',
            description:
              `Preferred ${option.name} for “${set.prompt.slice(0, 160)}”. ${preferenceText.trim() ? `Reason: ${preferenceText.trim().slice(0, 180)}.` : `Chosen design: ${option.description.slice(0, 180)}`} Treat as a soft preference.`.slice(
                0,
                500,
              ),
          });
          scene.design = {
            groups: [],
            connections: [],
            stairLinks: [],
            ...scene.design,
            requirements,
          };
          const issues = validateDesignChange(current.scene, scene);
          if (issues.some((i) => i.severity === 'error'))
            throw new DesignServiceError(
              'The chosen alternative no longer passes its design checks.',
            );
          return {
            ...editProject(current, scene),
            variants: [
              ...current.variants,
              ...set.result.options.map((o) => ({
                id: o.id,
                name: o.name,
                createdAt: new Date().toISOString(),
                scene: o.scene,
                thumbnail: o.thumbnail,
                description: o.description,
                intent: set.prompt,
                source: 'generated' as const,
              })),
            ],
            messages: [
              ...current.messages,
              {
                id: randomUUID(),
                role: 'user' as const,
                text: `Explore alternatives: ${set.prompt}`,
              },
              {
                id: randomUUID(),
                role: 'assistant' as const,
                text: `Kept ${option.name}. ${option.description}${preferenceText.trim() ? ` Remembered your preference: ${preferenceText.trim()}` : ''}`.slice(
                  0,
                  10000,
                ),
              },
            ].slice(-100),
          };
        },
        projectId,
      )
      .then((project) => {
        this.sets.delete(choiceSetId);
        return project;
      })
      .catch((error) => {
        this.accepted.delete(key);
        throw error;
      });
    this.accepted.set(key, operation);
    if (this.accepted.size > 64) this.accepted.delete(this.accepted.keys().next().value!);
    return operation;
  }
  private prune() {
    for (const [id, set] of this.sets)
      if (set.createdAt < Date.now() - 30 * 60_000) this.sets.delete(id);
  }
}

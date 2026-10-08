import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AlternativeService } from '../server/alternative-service.ts';
import { DesignServiceError } from '../server/design-service.ts';
import { ProjectStore, RevisionConflict } from '../server/storage.ts';
import { sceneFingerprint, type RenderProvider } from '../server/render-service.ts';
import type { AgentResult } from '../server/agent.ts';
import { emptyScene, makeRoom, newProject, type Project, type Scene } from '../shared/model.ts';
import { renderCamera, type RenderRequest } from '../shared/render.ts';

const thumbnail = 'data:image/png;base64,YWJj';
async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'terrain-alternatives-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ProjectStore(directory);
  const project = await store.save({
    ...newProject(),
    scene: { ...emptyScene, rooms: [makeRoom({ id: 'living', name: 'Living room' })] },
  });
  return { directory, store, project, service: new AlternativeService(store) };
}
function response(scene: Scene, index = 0): AgentResult {
  return {
    reply: index ? 'A brighter chalk finish.' : 'Warm cedar finishes.',
    scene,
    needsConfirmation: false,
    issues: [],
    changes: ['Changed the exterior material.'],
    events: [],
    usage: { calls: 2, inputTokens: 100, outputTokens: 50, cost: 0.01 },
  };
}
function materialBuild(project: Project) {
  return async (index: number) =>
    response({ ...structuredClone(project.scene), palette: index ? 'chalk' : 'cedar' }, index);
}
function renderer(captures: Array<{ scene: Scene; request: RenderRequest }> = []): RenderProvider {
  return async (scene, request) => {
    captures.push({ scene: structuredClone(scene), request: structuredClone(request) });
    const { position, target } = renderCamera(scene, request);
    return {
      image: thumbnail,
      width: 800,
      height: 600,
      camera: { position, target },
      sceneHash: sceneFingerprint(scene),
      view: request.view,
    };
  };
}

test('generating alternatives writes nothing and renders distinct options with one matching camera', async (t) => {
  const { directory, store, project, service } = await fixture(t);
  const bytes = await readFile(path.join(directory, 'workspace.json'), 'utf8');
  const captures: Array<{ scene: Scene; request: RenderRequest }> = [];
  const seenPrevious: number[] = [];
  const choices = await service.generate({
    project,
    prompt: 'Explore warm and light exteriors.',
    count: 2,
    render: renderer(captures),
    build: async (index, previous) => {
      seenPrevious.push(previous.length);
      return materialBuild(project)(index);
    },
  });
  assert.deepEqual(seenPrevious, [0, 1]);
  assert.equal(choices.options.length, 2);
  assert.equal(choices.projectId, project.projectId);
  assert.equal(choices.baseRevision, project.revision);
  assert.deepEqual(
    choices.options.map((option) => option.scene.palette),
    ['cedar', 'chalk'],
  );
  assert.ok(choices.options.every((option) => option.thumbnail === thumbnail));
  assert.deepEqual(captures[0].request.camera, captures[1].request.camera);
  assert.equal(captures[0].request.view, 'exterior');
  assert.equal(captures[0].request.light, captures[1].request.light);
  assert.deepEqual(choices.usage, { calls: 4, inputTokens: 200, outputTokens: 100, cost: 0.02 });
  assert.deepEqual(await store.read(), project);
  assert.equal(await readFile(path.join(directory, 'workspace.json'), 'utf8'), bytes);
});

test('choosing records a soft preference, saves every option and creates exactly one undo entry across retries', async (t) => {
  const { store, project, service } = await fixture(t);
  const choices = await service.generate({
    project,
    prompt: 'Explore the exterior.',
    count: 2,
    render: renderer(),
    build: materialBuild(project),
  });
  const chosen = choices.options[0];
  const [first, concurrent] = await Promise.all([
    service.choose(
      choices.choiceSetId,
      chosen.id,
      project.projectId!,
      project.revision,
      'The timber feels warmer.',
    ),
    service.choose(
      choices.choiceSetId,
      chosen.id,
      project.projectId!,
      project.revision,
      'Duplicate response',
    ),
  ]);
  assert.deepEqual(concurrent, first);
  assert.equal(first.revision, project.revision + 1);
  assert.equal(first.scene.palette, 'cedar');
  assert.deepEqual(first.past, [project.scene]);
  assert.equal(first.variants.length, 2);
  for (const option of choices.options) {
    const saved = first.variants.find((variant) => variant.id === option.id)!;
    assert.deepEqual(saved.scene, option.scene);
    assert.equal(saved.thumbnail, thumbnail);
    assert.equal(saved.source, 'generated');
    assert.equal(saved.intent, 'Explore the exterior.');
  }
  const preference = first.scene.design?.requirements.at(-1);
  assert.equal(preference?.kind, 'intent');
  assert.equal(preference?.source, 'preference');
  assert.match(preference?.description ?? '', /timber feels warmer/);
  assert.equal(first.messages.length, 2);
  const latest = await store.update(
    first.revision,
    (current) => ({
      ...current,
      messages: [...current.messages, { id: 'later', role: 'user', text: 'One more thought.' }],
    }),
    first.projectId,
  );
  const retry = await service.choose(
    choices.choiceSetId,
    chosen.id,
    project.projectId!,
    project.revision,
  );
  assert.deepEqual(retry, latest);
  assert.equal(retry.variants.length, 2);
  assert.equal(retry.past.length, 1);
});

test('stale scenes, stale revisions and other active projects cannot accept old alternatives', async (t) => {
  const { store, project, service } = await fixture(t);
  const choices = await service.generate({
    project,
    prompt: 'Try exterior finishes.',
    count: 2,
    render: renderer(),
    build: materialBuild(project),
  });
  const changed = await store.update(
    project.revision,
    (current) => ({ ...current, scene: { ...current.scene, palette: 'charcoal' } }),
    project.projectId,
  );
  await assert.rejects(
    service.choose(
      choices.choiceSetId,
      choices.options[0].id,
      project.projectId!,
      project.revision,
    ),
    RevisionConflict,
  );
  await assert.rejects(
    service.choose(
      choices.choiceSetId,
      choices.options[0].id,
      project.projectId!,
      changed.revision,
    ),
    (error) =>
      error instanceof DesignServiceError &&
      error.code === 'stale_alternatives' &&
      error.status === 409,
  );
  assert.deepEqual(await store.read(), changed);
  const other = await store.createProject('Another home', changed.projectId!, changed.revision);
  await assert.rejects(
    service.choose(choices.choiceSetId, choices.options[0].id, other.projectId!, other.revision),
    RevisionConflict,
  );
  await assert.rejects(
    service.choose(choices.choiceSetId, choices.options[0].id, project.projectId!, other.revision),
    RevisionConflict,
  );
  assert.deepEqual(await store.read(), other);
});

test('even accepted-choice retries are bound to the project where the choice was made', async (t) => {
  const { store, project, service } = await fixture(t);
  const choices = await service.generate({
    project,
    prompt: 'Try finishes.',
    count: 2,
    render: renderer(),
    build: materialBuild(project),
  });
  const chosen = await service.choose(
    choices.choiceSetId,
    choices.options[0].id,
    project.projectId!,
    project.revision,
  );
  const other = await store.createProject('Another home', chosen.projectId!, chosen.revision);
  await assert.rejects(
    service.choose(choices.choiceSetId, choices.options[0].id, other.projectId!, other.revision),
    RevisionConflict,
  );
  assert.deepEqual(await store.read(), other);
});

test('name-only, identical, reordered or ID-renamed scenes cannot masquerade as distinct visual choices', async (t) => {
  const { store, project, service } = await fixture(t);
  await assert.rejects(
    service.generate({
      project,
      prompt: 'Try finishes.',
      count: 2,
      render: renderer(),
      build: async () => response({ ...project.scene, name: 'A new title' }),
    }),
    /distinct visual alternatives/,
  );
  for (const redundant of ['room', 'surface']) {
    await assert.rejects(
      service.generate({
        project,
        prompt: 'Try a genuinely different finish.',
        count: 2,
        render: renderer(),
        build: async () => {
          const scene = structuredClone(project.scene);
          if (redundant === 'room') scene.rooms[0].palette = scene.palette;
          else scene.rooms[0].surfacePalettes = { east: scene.palette };
          return response(scene);
        },
      }),
      /distinct visual alternatives/,
      'explicit overrides matching inherited materials are visually unchanged',
    );
  }
  await assert.rejects(
    service.generate({
      project,
      prompt: 'Try finishes.',
      count: 2,
      render: renderer(),
      build: async () => response({ ...project.scene, palette: 'cedar' }),
    }),
    /distinct visual alternatives/,
  );
  const twoRooms = {
    ...project,
    scene: {
      ...project.scene,
      rooms: [makeRoom({ id: 'a', x: 0, east: 'open' }), makeRoom({ id: 'b', x: 6, west: 'open' })],
    },
  };
  for (const variation of ['order', 'ids']) {
    await assert.rejects(
      service.generate({
        project: twoRooms,
        prompt: 'Try two truly different looks.',
        count: 2,
        render: renderer(),
        build: async (index) => {
          const scene = { ...structuredClone(twoRooms.scene), palette: 'cedar' as const };
          if (index)
            scene.rooms =
              variation === 'order'
                ? scene.rooms.reverse()
                : scene.rooms.map((room) => ({ ...room, id: `${room.id}-new` }));
          return response(scene, index);
        },
      }),
      /distinct visual alternatives/,
      `${variation} differences do not change rendered geometry`,
    );
  }
  assert.deepEqual(await store.read(), project);
});

test('cancellation and failed generation or mismatched captures preserve the original project', async (t) => {
  const { store, project, service } = await fixture(t);
  const controller = new AbortController();
  await assert.rejects(
    service.generate({
      project,
      prompt: 'Explore finishes.',
      count: 2,
      signal: controller.signal,
      render: renderer(),
      build: async (index) => {
        controller.abort();
        return materialBuild(project)(index);
      },
    }),
    { name: 'AbortError' },
  );
  await assert.rejects(
    service.generate({
      project,
      prompt: 'Explore finishes.',
      count: 2,
      render: async (scene, request) => ({
        ...(await renderer()(scene, request)),
        sceneHash: '0'.repeat(64),
      }),
      build: materialBuild(project),
    }),
    /match/,
  );
  await assert.rejects(
    service.generate({
      project,
      prompt: 'Explore finishes.',
      count: 2,
      render: async (scene, request) => ({
        ...(await renderer()(scene, request)),
        camera: { position: [999, 999, 999], target: [0, 0, 0] },
      }),
      build: materialBuild(project),
    }),
    /camera|match/,
  );
  await assert.rejects(
    service.generate({
      project,
      prompt: 'Explore finishes.',
      count: 2,
      render: renderer(),
      build: async (index) => {
        if (index) throw new Error('Model failed');
        return materialBuild(project)(index);
      },
    }),
    /Model failed/,
  );
  assert.deepEqual(await store.read(), project);
});

test('unknown usage remains unknown and exceeding variant capacity spends no generation calls', async (t) => {
  const { project, service } = await fixture(t);
  const choices = await service.generate({
    project,
    prompt: 'Try finishes.',
    count: 2,
    render: renderer(),
    build: async (index) => {
      const option = await materialBuild(project)(index);
      if (index) option.usage.cost = null;
      return option;
    },
  });
  assert.equal(choices.usage.cost, null);
  let calls = 0;
  await assert.rejects(
    service.generate({
      project: {
        ...project,
        variants: Array.from({ length: 29 }, (_, index) => ({
          id: String(index),
          name: 'Saved',
          createdAt: '2026-09-28',
          scene: project.scene,
        })),
      },
      prompt: 'More looks.',
      count: 2,
      render: renderer(),
      build: async (index) => {
        calls++;
        return materialBuild(project)(index);
      },
    }),
    /30/,
  );
  assert.equal(calls, 0);
});

test('comparison framing includes tall chimneys and pitched roofs added by the alternatives', async (t) => {
  const { project, service } = await fixture(t);
  const captures: Array<{ scene: Scene; request: RenderRequest }> = [];
  await service.generate({
    project,
    prompt: 'Explore roof and chimney silhouettes.',
    count: 2,
    render: renderer(captures),
    build: async (index) => {
      const option = await materialBuild(project)(index);
      if (index) {
        option.scene!.roof = 'pitched';
        option.scene!.fireplace = { x: 0, z: 0, elevation: 0, height: 16 };
      }
      return option;
    },
  });
  assert.deepEqual(captures[0].request.camera, captures[1].request.camera);
  assert.ok(
    captures[0].request.camera!.target[1] > 7,
    'the fit must include the 16 m chimney instead of only 3.2 m room walls',
  );
  assert.ok(captures[0].request.camera!.position[1] > 16);
});

test('valid long model replies still produce choices that can be saved within variant limits', async (t) => {
  const { project, service, store } = await fixture(t);
  const choices = await service.generate({
    project,
    prompt: 'Compare materials.',
    count: 2,
    render: renderer(),
    build: async (index) => {
      const option = await materialBuild(project)(index);
      option.reply = 'A'.repeat(1100);
      return option;
    },
  });
  const chosen = await service.choose(
    choices.choiceSetId,
    choices.options[0].id,
    project.projectId!,
    project.revision,
  );
  assert.equal(chosen.variants.length, 2);
  assert.ok(chosen.variants.every((variant) => (variant.description?.length ?? 0) <= 1000));
  assert.deepEqual(await store.read(), chosen);
});

test('expired choices and cancellation during rendering never change the saved house', async (t) => {
  const { project, service, store } = await fixture(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const choices = await service.generate({
    project,
    prompt: 'Compare materials.',
    count: 2,
    render: renderer(),
    build: materialBuild(project),
  });
  now += 31 * 60_000;
  await assert.rejects(
    service.choose(
      choices.choiceSetId,
      choices.options[0].id,
      project.projectId!,
      project.revision,
    ),
    /expired/,
  );
  const controller = new AbortController();
  let captures = 0;
  await assert.rejects(
    service.generate({
      project,
      prompt: 'Compare materials.',
      count: 2,
      signal: controller.signal,
      build: materialBuild(project),
      render: async (scene, request) => {
        captures++;
        controller.abort();
        return renderer()(scene, request);
      },
    }),
    { name: 'AbortError' },
  );
  assert.equal(captures, 1);
  assert.deepEqual(await store.read(), project);
});

test('refined alternatives retain originals without saving and adoption has one undo step', async (t) => {
  const { service, store, project } = await fixture(t);
  const choices = await service.generate({
    project,
    prompt: 'Explore finishes.',
    count: 2,
    render: renderer(),
    build: materialBuild(project),
  });
  const originals = structuredClone(choices.options);
  const selected = await service.source(
    choices.choiceSetId,
    choices.options[0].id,
    project.projectId!,
    project.revision,
  );
  const refinedScene = structuredClone(selected.scene);
  refinedScene.rooms[0].surfacePalettes = { north: 'chalk' };
  const refined = await service.appendRefinement({
    choiceSetId: choices.choiceSetId,
    optionId: selected.option.id,
    projectId: project.projectId!,
    expectedRevision: project.revision,
    answer: response(refinedScene),
    render: renderer(),
  });
  assert.deepEqual(refined.choices.options.slice(0, 2), originals);
  assert.equal(refined.choices.options[2].parentOptionId, selected.option.id);
  assert.deepEqual(await store.read(), project);
  const accepted = await service.choose(
    choices.choiceSetId,
    refined.refinedOptionId,
    project.projectId!,
    project.revision,
  );
  assert.equal(accepted.scene.rooms[0].surfacePalettes?.north, 'chalk');
  assert.equal(accepted.past.length, 1);
  assert.deepEqual(accepted.past[0], project.scene);
  assert.equal(accepted.variants.length, 3);
  assert.deepEqual(
    accepted.variants.slice(0, 2).map((option) => option.scene),
    originals.map((option) => option.scene),
  );
});

test('negative review refinement requires explicit adoption confirmation; discard preserves original choices', async (t) => {
  const { service, store, project } = await fixture(t);
  const choices = await service.generate({
    project,
    prompt: 'Explore finishes.',
    count: 2,
    render: renderer(),
    build: materialBuild(project),
  });
  const selected = choices.options[0];
  const refinedScene = structuredClone(selected.scene);
  refinedScene.rooms[0].surfacePalettes = { north: 'chalk' };
  const answer = {
    ...response(refinedScene),
    needsConfirmation: true,
    reply: 'Still outstanding: wall consistency is unverified.',
  };
  const refined = await service.appendRefinement({
    choiceSetId: choices.choiceSetId,
    optionId: selected.id,
    projectId: project.projectId!,
    expectedRevision: project.revision,
    answer,
    render: renderer(),
  });
  await assert.rejects(
    service.choose(
      choices.choiceSetId,
      refined.refinedOptionId,
      project.projectId!,
      project.revision,
    ),
    /Confirm/,
  );
  assert.deepEqual(await store.read(), project);
  const remaining = await service.discardRefinement(
    choices.choiceSetId,
    refined.refinedOptionId,
    project.projectId!,
    project.revision,
  );
  assert.deepEqual(remaining.options, choices.options);
  await assert.rejects(
    service.discardRefinement(
      choices.choiceSetId,
      selected.id,
      project.projectId!,
      project.revision,
    ),
    /Original choices/,
  );
});

test('failed, cancelled and stale alternative refinements never publish a new option or save geometry', async (t) => {
  const { service, store, project } = await fixture(t);
  const choices = await service.generate({
    project,
    prompt: 'Explore finishes.',
    count: 2,
    render: renderer(),
    build: materialBuild(project),
  });
  const selected = choices.options[0];
  const refinedScene = structuredClone(selected.scene);
  refinedScene.rooms[0].surfacePalettes = { north: 'chalk' };
  const parameters = {
    choiceSetId: choices.choiceSetId,
    optionId: selected.id,
    projectId: project.projectId!,
    expectedRevision: project.revision,
    answer: response(refinedScene),
  };
  await assert.rejects(
    service.appendRefinement({
      ...parameters,
      render: async () => {
        throw new Error('Render failed');
      },
    }),
    /Render failed/,
  );
  const controller = new AbortController();
  await assert.rejects(
    service.appendRefinement({
      ...parameters,
      signal: controller.signal,
      render: async (...args) => {
        const capture = await renderer()(...args);
        controller.abort();
        return capture;
      },
    }),
    /abort/i,
  );
  assert.deepEqual(
    (await service.source(choices.choiceSetId, selected.id, project.projectId!, project.revision))
      .option,
    selected,
  );
  assert.deepEqual(await store.read(), project);
  await assert.rejects(
    service.appendRefinement({
      ...parameters,
      render: async (...args) => {
        const capture = await renderer()(...args);
        await store.save({ ...project, scene: { ...project.scene, palette: 'chalk' } });
        return capture;
      },
    }),
    /changed|saved|revision/i,
  );
});

test('minor alternative refinement cannot erase source failures, while a repaired source check is fulfilled', async (t) => {
  const { evaluateDesignAssessment, designAssessmentSchema } =
    await import('../shared/assessment.ts');
  const { service, project } = await fixture(t);
  const choices = await service.generate({
    project,
    prompt: 'Use a single-pitch roof.',
    count: 2,
    render: renderer(),
    build: async (index) => {
      const candidate = {
        ...structuredClone(project.scene),
        palette: index ? ('chalk' as const) : ('cedar' as const),
      };
      return {
        ...response(candidate),
        needsConfirmation: true,
        assessment: evaluateDesignAssessment(
          candidate,
          designAssessmentSchema.parse({
            requirements: [
              {
                id: 'roof',
                request: 'A single-pitch roof.',
                status: 'fulfilled',
                evidence: 'Roof checked.',
                checks: [{ kind: 'roof', roomId: candidate.rooms[0].id, style: 'single-pitch' }],
              },
            ],
          }),
        ),
      };
    },
  });
  const selected = choices.options[0];
  const refinedScene = structuredClone(selected.scene);
  refinedScene.rooms[0].surfacePalettes = { floor: 'chalk' };
  const refined = await service.appendRefinement({
    choiceSetId: choices.choiceSetId,
    optionId: selected.id,
    projectId: project.projectId!,
    expectedRevision: project.revision,
    answer: response(refinedScene),
    render: renderer(),
  });
  const option = refined.choices.options.at(-1)!;
  assert.equal(option.needsConfirmation, true);
  assert.equal(option.assessment?.requirements[0].status, 'partial');
  assert.match(option.description, /Still outstanding.*single-pitch roof/);
  await assert.rejects(
    service.choose(choices.choiceSetId, option.id, project.projectId!, project.revision),
    /Confirm/,
  );
  const repairedScene = {
    ...refinedScene,
    roof: 'single-pitch' as const,
    roofPitch: 12,
    roofDirection: 'north' as const,
  };
  const repaired = await service.appendRefinement({
    choiceSetId: choices.choiceSetId,
    optionId: option.id,
    projectId: project.projectId!,
    expectedRevision: project.revision,
    answer: response(repairedScene),
    render: renderer(),
  });
  assert.equal(repaired.choices.options.at(-1)!.assessment?.requirements[0].status, 'fulfilled');
});

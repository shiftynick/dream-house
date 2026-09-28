import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { createApplication } from '../server/app.ts';
import { sceneFingerprint } from '../server/render-service.ts';
import { emptyScene, makeRoom, newProject } from '../shared/model.ts';
import { renderCamera } from '../shared/render.ts';

test(
  'HTTP distinguishes outdated alternatives from a conflicting project revision and leaves the house editable',
  { timeout: 10000 },
  async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'terrain-choice-lifecycle-'));
    const application = await createApplication({ directory, env: {} });
    const project = await application.store.save({
      ...newProject(),
      scene: { ...emptyScene, rooms: [makeRoom({ id: 'living' })] },
    });
    const server = application.app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    t.after(async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    });
    const request = async (route: string, method: string, body: unknown) => {
      const result = await fetch(url + route, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: result.status, body: await result.json() };
    };
    const choices = await application.alternatives.generate({
      project,
      prompt: 'Compare finishes.',
      count: 2,
      build: async (index) => ({
        scene: { ...structuredClone(project.scene), palette: index ? 'chalk' : 'cedar' },
        reply: 'A different finish.',
        needsConfirmation: false,
        changes: ['Changed finishes.'],
        issues: [],
        events: [],
        usage: { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 },
      }),
      render: async (scene, request) => {
        const { position, target } = renderCamera(scene, request);
        return {
          image: 'data:image/png;base64,YWJj',
          width: 800,
          height: 600,
          sceneHash: sceneFingerprint(scene),
          view: request.view,
          camera: { position, target },
        };
      },
    });
    const edited = await request('/api/project', 'PUT', {
      ...project,
      scene: { ...project.scene, palette: 'charcoal' },
    });
    assert.equal(edited.status, 200);
    const selected = {
      choiceSetId: choices.choiceSetId,
      optionId: choices.options[0].id,
      projectId: project.projectId,
    };
    const staleRevision = await request('/api/alternatives/choose', 'POST', {
      ...selected,
      expectedRevision: project.revision,
    });
    assert.equal(staleRevision.status, 409);
    assert.equal(staleRevision.body.code, 'revision_conflict');
    const staleChoices = await request('/api/alternatives/choose', 'POST', {
      ...selected,
      expectedRevision: edited.body.project.revision,
    });
    assert.equal(staleChoices.status, 409);
    assert.equal(staleChoices.body.code, 'stale_alternatives');
    assert.match(staleChoices.body.error, /Generate fresh choices/);
    const next = await request('/api/project', 'PUT', {
      ...edited.body.project,
      scene: { ...edited.body.project.scene, name: 'Still editable' },
    });
    assert.equal(next.status, 200);
    assert.equal(next.body.project.scene.palette, 'charcoal');
    assert.equal(next.body.project.scene.name, 'Still editable');
    assert.equal(next.body.project.variants.length, 0);
    assert.equal((await application.store.read()).scene.name, 'Still editable');
  },
);

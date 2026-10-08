import test from 'node:test';
import assert from 'node:assert/strict';
import { compactStaleToolResults } from '../server/agent-history.ts';
import type { ModelMessage } from '../server/agent.ts';
import { emptyScene, makeRoom } from '../shared/model.ts';
import { inspectDesign } from '../shared/design.ts';
import { inspectDesignQuality } from '../shared/design-quality.ts';

const scene = {
  ...emptyScene,
  rooms: Array.from({ length: 10 }, (_, i) =>
    makeRoom({ id: `room-${i}`, name: `Lodge room ${i}`, x: i * 12 }),
  ),
};
const inspection = inspectDesign(scene);
const quality = inspectDesignQuality(scene);
const assistant = (id: string, name: string): ModelMessage => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: '{}' } }],
});
const output = (id: string, payload: unknown): ModelMessage => ({
  role: 'tool',
  tool_call_id: id,
  content: JSON.stringify(payload),
});
const compact = (messages: ModelMessage[]) =>
  compactStaleToolResults(messages, { authoritativeSnapshotAvailable: true });

test('ten-room repeated snapshots shrink while protocol, constraints, failures and current outputs survive', () => {
  const constraint = {
    id: 'protect-bedroom',
    priority: 'required',
    status: 'unmet',
    checks: [{ kind: 'unchanged_room', roomId: 'room-0' }],
    evidence: 'Keep the original baseline.',
  };
  const issue = { path: 'operations.0.width', message: 'Too small' };
  const payload = {
    ok: false,
    scene,
    inspection,
    quality,
    issues: [issue],
    changes: [{ operation: 'resize_room', objectIds: ['room-0'] }],
    repair: { errors: [issue] },
    preservationResults: [{ passed: false }],
    assessment: {
      requirements: [constraint],
      assumptions: [{ description: 'Original baseline', requiresConfirmation: true }],
    },
  };
  const image: ModelMessage = {
    role: 'user',
    content: [
      { type: 'text', text: 'Capture capture-1, scene exact-hash, exterior' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
    ],
  };
  const messages: ModelMessage[] = [
    { role: 'system', content: 'Refreshed authoritative snapshot' },
  ];
  for (let i = 0; i < 6; i++)
    messages.push(
      assistant(`old-${i}`, i % 2 ? 'inspect_design' : 'apply_operations'),
      output(`old-${i}`, payload),
    );
  messages.push(
    assistant('review', 'critique_design'),
    output('review', {
      critique: {
        sceneHash: 'exact-hash',
        captureIds: ['capture-1'],
        observations: [{ status: 'needs_repair', evidence: 'Dining lacks chairs.' }],
      },
      assessment: payload.assessment,
      plan: { intent: 'Grand lodge' },
    }),
    image,
    assistant('latest', 'inspect_design'),
    output('latest', payload),
  );
  const original = JSON.stringify(messages);
  const result = compact(messages);
  assert.ok(JSON.stringify(result).length < original.length * 0.4);
  assert.equal(JSON.stringify(messages), original);
  assert.deepEqual(
    result.map((m) => [m.role, m.tool_call_id, m.tool_calls]),
    messages.map((m) => [m.role, m.tool_call_id, m.tool_calls]),
  );
  const old = JSON.parse(String(result[2].content));
  assert.equal(old.scene, undefined);
  assert.equal(old.inspection, undefined);
  assert.equal(old.quality, undefined);
  for (const key of ['issues', 'changes', 'repair', 'preservationResults', 'assessment'])
    assert.deepEqual(old[key], payload[key as keyof typeof payload]);
  assert.deepEqual(old.historicalInspectionIssues, inspection.issues);
  assert.deepEqual(old.historicalQualityLimitations, quality.limitations);
  assert.equal(result.at(-1), messages.at(-1));
  assert.equal(result[result.length - 3], image);
  assert.equal(result[14], messages[14]);
  assert.deepEqual(compact(result), result);
});

test('unknown, unmatched, malformed and ambiguous results stay untouched and snapshot refresh is required', () => {
  const messages = [
    assistant('unknown', 'future_tool'),
    output('unknown', { scene, quality }),
    output('unmatched', { scene }),
    assistant('bad', 'inspect_design'),
    output('bad', 'bad'),
    assistant('duplicate', 'inspect_design'),
    output('duplicate', { scene }),
    assistant('duplicate', 'apply_operations'),
    output('duplicate', { scene }),
    assistant('latest', 'reset_draft'),
    output('latest', { inspection }),
  ];
  const result = compact(messages);
  assert.deepEqual(result, messages);
  assert.equal(
    compactStaleToolResults(messages, { authoritativeSnapshotAvailable: false }),
    messages,
  );
});

test('all outputs from the latest multi-tool model turn remain full, even with later image messages', () => {
  const latest = assistant('inspect', 'inspect_design');
  latest.tool_calls!.push(...assistant('apply', 'apply_operations').tool_calls!);
  const messages = [
    assistant('old', 'reset_draft'),
    output('old', { inspection }),
    latest,
    output('inspect', { inspection, quality }),
    output('apply', { scene, changes: [] }),
    {
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } }],
    } as ModelMessage,
  ];
  const result = compact(messages);
  assert.notEqual(result[1].content, messages[1].content);
  assert.deepEqual(result.slice(2), messages.slice(2));
});

test('old compose snapshots compact without changing its plan, checklist, failures or latest tool turn', () => {
  const plan = { intent: 'Retain the complete architecture.', roomProgram: [{ roomId: 'room-0' }] };
  const assessment = {
    requirements: [
      {
        id: 'arrival',
        checks: [{ kind: 'wall_opening', roomId: 'room-0', openingKind: 'door' }],
        evidence: 'Required route.',
        status: 'unmet',
      },
    ],
    assumptions: [{ description: 'Confirmed owner condition.', requiresConfirmation: true }],
  };
  const issues = [
    {
      code: 'clearance',
      severity: 'warning',
      message: 'Schematic constraint.',
      objectIds: ['room-0'],
    },
  ];
  const composed = {
    ok: true,
    scene,
    quality,
    plan,
    assessment,
    issues,
    changes: ['Added the scaffold.'],
  };
  const messages = [
    assistant('compose', 'compose_house'),
    output('compose', composed),
    assistant('latest', 'inspect_design'),
    output('latest', { inspection, quality, issues }),
  ];
  const result = compact(messages);
  const old = JSON.parse(String(result[1].content));
  assert.equal(old.scene, undefined);
  assert.equal(old.quality, undefined);
  assert.deepEqual(old.plan, plan);
  assert.deepEqual(old.assessment, assessment);
  assert.deepEqual(old.issues, issues);
  assert.deepEqual(old.changes, composed.changes);
  assert.deepEqual(result[3], messages[3]);
});

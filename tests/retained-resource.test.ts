import test from 'node:test';
import assert from 'node:assert/strict';
import { RetainedResource } from '../src/retainedResource';

test('pausing and re-entering refinement reuses one expensive renderer and releases it once', async () => {
  let created = 0,
    released = 0;
  const owner = new RetainedResource<object>(() => released++);
  const create = async () => {
    created++;
    return {};
  };
  const first = await owner.acquire(create);
  assert.equal(await owner.acquire(create), first);
  assert.equal(await owner.acquire(create), first);
  assert.equal(created, 1);
  owner.dispose();
  owner.dispose();
  assert.equal(released, 1);
  assert.equal(await owner.acquire(create), null);
  assert.equal(created, 1);
});

test('context loss invalidates a pending renderer without disposing its replacement', async () => {
  const released: string[] = [];
  const owner = new RetainedResource<string>((value) => released.push(value));
  let finish!: (value: string) => void;
  const stale = owner.acquire(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await Promise.resolve();
  owner.clear();
  assert.equal(await owner.acquire(async () => 'new'), 'new');
  finish('old');
  assert.equal(await stale, null);
  assert.deepEqual(released, ['old']);
  assert.equal(await owner.acquire(async () => 'unwanted'), 'new');
  owner.dispose();
  assert.deepEqual(released, ['old', 'new']);
});

test('unmount releases asynchronous initialization that finishes after its canvas disappeared', async () => {
  const released: string[] = [];
  const owner = new RetainedResource<string>((value) => released.push(value));
  let finish!: (value: string) => void;
  const first = owner.acquire(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const same = owner.acquire(async () => 'second');
  await Promise.resolve();
  owner.dispose();
  finish('late');
  assert.equal(await first, null);
  assert.equal(await same, null);
  assert.deepEqual(released, ['late']);
});

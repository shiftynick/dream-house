import test from 'node:test';
import assert from 'node:assert/strict';
import { GpuSchedule } from '../src/gpuSchedule';

function device() {
  let result = 2,
    deleted = 0,
    submitted = 0,
    lost = false;
  const context = {
    WAIT_FAILED: 1,
    TIMEOUT_EXPIRED: 2,
    CONDITION_SATISFIED: 3,
    SYNC_GPU_COMMANDS_COMPLETE: 4,
    isContextLost: () => lost,
    clientWaitSync: () => result,
    deleteSync: () => deleted++,
    fenceSync: () => {
      submitted++;
      return {};
    },
    flush: () => {},
  } as unknown as WebGL2RenderingContext;
  return {
    context,
    complete: () => {
      result = 3;
    },
    pending: () => {
      result = 2;
    },
    fail: () => {
      result = 1;
    },
    lose: () => {
      lost = true;
    },
    counts: () => ({ deleted, submitted }),
  };
}

test('an unpaced refinement caller cannot queue more than one GPU batch', () => {
  const gpu = device(),
    schedule = new GpuSchedule(gpu.context, 16);
  assert.equal(schedule.ready(0), true);
  schedule.submittedFrame(0);
  for (let index = 1; index < 10_000; index++) assert.equal(schedule.ready(index / 10), false);
  assert.deepEqual(gpu.counts(), { deleted: 0, submitted: 1 });
  gpu.complete();
  assert.equal(schedule.ready(1000), true);
  schedule.submittedFrame(1000);
  assert.equal(schedule.ready(1001), false, 'completed work still respects pacing');
  schedule.dispose();
  assert.deepEqual(gpu.counts(), { deleted: 2, submitted: 2 });
});

test('lost, stalled, or failed graphics work never starts another GPU batch', () => {
  const gpu = device(),
    schedule = new GpuSchedule(gpu.context);
  assert.equal(schedule.ready(0), true);
  schedule.submittedFrame(0);
  assert.throws(() => schedule.ready(12_001), /too long/);
  gpu.fail();
  assert.throws(() => schedule.ready(12_002), /could not finish/);
  gpu.lose();
  assert.equal(schedule.ready(12_003), false);
  schedule.dispose();
});

test('initial shader compilation has a longer bounded fence budget than ordinary frames', () => {
  const gpu = device(),
    schedule = new GpuSchedule(gpu.context);
  assert.equal(schedule.ready(0), true);
  schedule.submittedFrame(0);
  assert.equal(
    schedule.ready(20_000, 45_000),
    false,
    'slow startup stays paused without rejecting compilation',
  );
  assert.throws(() => schedule.ready(45_001, 45_000), /too long/);
  gpu.complete();
  assert.equal(schedule.ready(45_002), true);
  schedule.dispose();
});

test('finishing compilation cannot shorten its in-flight batch deadline, but later draws use the normal deadline', () => {
  const gpu = device(),
    schedule = new GpuSchedule(gpu.context);
  assert.equal(schedule.ready(0), true);
  schedule.submittedFrame(0);
  assert.equal(schedule.ready(20_000, 45_000), false);
  assert.equal(
    schedule.ready(29_000),
    false,
    'a completed compiler does not retroactively reject its queued GPU work',
  );
  assert.equal(schedule.ready(44_000), false);
  gpu.complete();
  assert.equal(schedule.ready(44_001), true);
  schedule.submittedFrame(44_001);
  gpu.pending();
  assert.throws(
    () => schedule.ready(56_002),
    /too long/,
    'a new ordinary batch returns to the 12-second limit',
  );
  schedule.dispose();
});

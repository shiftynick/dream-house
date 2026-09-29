import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  VoiceSession,
  type VoiceContext,
  type VoiceDependencies,
  type VoiceState,
} from '../src/voiceSession.ts';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
class FakeRecorder {
  state = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.onstop?.();
  }
  data(size = 1000) {
    this.ondataavailable?.({ data: new Blob(['a'.repeat(size)], { type: this.mimeType }) });
  }
}
function setup(t: TestContext, overrides: Partial<VoiceDependencies> = {}) {
  const context: VoiceContext = { enabled: true, busy: false, scopeKey: 'house-a' };
  const states: VoiceState[] = [],
    texts: string[] = [],
    errors: string[] = [];
  let tracksStopped = 0;
  const stream = {
    getTracks: () => [
      {
        stop: () => {
          tracksStopped++;
        },
      },
    ],
  } as unknown as MediaStream;
  const recordings: FakeRecorder[] = [];
  const transcripts: Array<{ blob: Blob; signal: AbortSignal }> = [];
  const transcription = deferred<{ text: string }>();
  const session = new VoiceSession({
    context: () => context,
    supported: () => true,
    microphone: async () => stream,
    recorder: () => {
      const recorder = new FakeRecorder();
      recordings.push(recorder);
      return recorder as unknown as MediaRecorder;
    },
    transcribe: (blob, signal) => {
      transcripts.push({ blob, signal });
      return transcription.promise;
    },
    onState: (state) => states.push(state),
    onText: (text) => texts.push(text),
    onError: (message) => errors.push(message),
    ...overrides,
  });
  t.after(() => session.cancel(false));
  return {
    session,
    context,
    states,
    texts,
    errors,
    stream,
    recordings,
    transcripts,
    transcription,
    get tracksStopped() {
      return tracksStopped;
    },
  };
}
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test('push-to-talk releases tracks before transcription and delivers a single trimmed transcript', async (t) => {
  const fixture = setup(t);
  await fixture.session.start();
  fixture.recordings[0].data();
  fixture.session.stop();
  fixture.session.stop();
  assert.equal(fixture.tracksStopped, 1);
  assert.equal(fixture.transcripts.length, 1);
  assert.equal(fixture.transcripts[0].blob.type, 'audio/webm');
  assert.equal(fixture.states.at(-1), 'transcribing');
  fixture.transcription.resolve({ text: '  Add south windows.  ' });
  await settle();
  assert.deepEqual(fixture.texts, ['Add south windows.']);
  assert.deepEqual(fixture.states, ['requesting', 'recording', 'transcribing', 'idle']);
  assert.deepEqual(fixture.errors, []);
});

test('release or cancellation during pending microphone permission stops a late stream without recording', async (t) => {
  for (const cancelled of [false, true]) {
    const permission = deferred<MediaStream>();
    const fixture = setup(t, { microphone: () => permission.promise });
    const starting = fixture.session.start();
    if (cancelled) fixture.session.cancel(false);
    else fixture.session.stop();
    permission.resolve(fixture.stream);
    await starting;
    assert.equal(fixture.tracksStopped, 1);
    assert.equal(fixture.recordings.length, 0);
    assert.equal(fixture.transcripts.length, 0);
    assert.deepEqual(fixture.errors, []);
  }
});

test('project switch or disabled controls aborts transcription and ignores late success and failure', async (t) => {
  for (const reason of ['project', 'busy', 'disabled'] as const) {
    for (const rejection of [false, true]) {
      const fixture = setup(t);
      await fixture.session.start();
      fixture.recordings[0].data();
      fixture.session.stop();
      if (reason === 'project') fixture.context.scopeKey = 'house-b';
      if (reason === 'busy') fixture.context.busy = true;
      if (reason === 'disabled') fixture.context.enabled = false;
      fixture.session.synchronize();
      assert.equal(fixture.transcripts[0].signal.aborted, true);
      if (rejection) fixture.transcription.reject(new Error('Late provider failure'));
      else fixture.transcription.resolve({ text: 'Edit the previous project.' });
      await settle();
      assert.deepEqual(fixture.texts, []);
      assert.deepEqual(fixture.errors, []);
      assert.equal(fixture.states.at(-1), 'idle');
    }
  }
});

test('late transcript checks live project identity even before the React cleanup effect runs', async (t) => {
  const fixture = setup(t);
  await fixture.session.start();
  fixture.recordings[0].data();
  fixture.session.stop();
  fixture.context.scopeKey = 'house-b';
  fixture.transcription.resolve({ text: 'Stale speech.' });
  await settle();
  assert.deepEqual(fixture.texts, []);
  assert.deepEqual(fixture.errors, []);
});

test('recording errors cannot trigger transcription through an already queued stop event', async (t) => {
  const fixture = setup(t);
  await fixture.session.start();
  const recorder = fixture.recordings[0];
  recorder.data();
  const queuedStop = recorder.onstop!;
  recorder.onerror!();
  queuedStop();
  await settle();
  assert.equal(fixture.tracksStopped, 1);
  assert.equal(fixture.transcripts.length, 0);
  assert.deepEqual(fixture.texts, []);
  assert.equal(fixture.errors.length, 1);
  assert.match(fixture.errors[0], /stopped unexpectedly/);
});

test('unmount cancellation suppresses subsequent callbacks and can be reused after StrictMode cleanup', async (t) => {
  const fixture = setup(t);
  await fixture.session.start();
  fixture.recordings[0].data();
  fixture.session.stop();
  const statesBeforeUnmount = fixture.states.length;
  fixture.session.cancel(false);
  fixture.transcription.resolve({ text: 'Discard this transcript.' });
  await settle();
  assert.equal(fixture.states.length, statesBeforeUnmount);
  assert.deepEqual(fixture.texts, []);
  await fixture.session.start();
  assert.equal(fixture.recordings.length, 2);
  assert.equal(fixture.states.at(-1), 'recording');
});

test('a superseded permission rejection cannot cancel or report an error over a new recording', async (t) => {
  const permission = deferred<MediaStream>();
  let requests = 0;
  const fixture = setup(t, {
    microphone: () => (requests++ ? Promise.resolve(fixture.stream) : permission.promise),
  });
  const first = fixture.session.start();
  fixture.session.cancel();
  await fixture.session.start();
  permission.reject(new DOMException('Denied old request', 'NotAllowedError'));
  await first;
  assert.equal(fixture.states.at(-1), 'recording');
  assert.deepEqual(fixture.errors, []);
  assert.equal(fixture.recordings.length, 1);
});

test('recorder construction/start failures release the microphone and a short recording makes no cloud request', async (t) => {
  for (const failOnStart of [false, true]) {
    const fixture = setup(t, {
      recorder: () => {
        if (!failOnStart) throw new Error('No supported recorder');
        const recorder = new FakeRecorder();
        recorder.start = () => {
          throw new Error('Device busy');
        };
        return recorder as unknown as MediaRecorder;
      },
    });
    await fixture.session.start();
    assert.equal(fixture.tracksStopped, 1);
    assert.equal(fixture.errors.length, 1);
  }
  const fixture = setup(t);
  await fixture.session.start();
  fixture.recordings[0].data(20);
  fixture.session.stop();
  await settle();
  assert.equal(fixture.transcripts.length, 0);
  assert.match(fixture.errors[0], /little short/);
  assert.equal(fixture.tracksStopped, 1);
});

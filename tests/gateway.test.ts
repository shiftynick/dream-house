import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ConnectionStore,
  connectionSettingsSchema,
  resolveConnections,
} from '../server/connections.ts';
import {
  GatewayError,
  normalizeAudioMediaType,
  reportedCost,
  synthesizeSpeech,
  transcribeAudio,
} from '../server/gateway.ts';
import { DEFAULT_MODELS } from '../shared/connections.ts';

function wav() {
  const audio = Buffer.alloc(52);
  audio.write('RIFF', 0);
  audio.writeUInt32LE(44, 4);
  audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(24000, 24);
  audio.writeUInt32LE(48000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write('data', 36);
  audio.writeUInt32LE(8, 40);
  return audio;
}

test('gateway defaults preserve requested TTS and do not reuse legacy provider keys', () => {
  const settings = connectionSettingsSchema.parse({
    openrouterKey: 'old-router-secret',
    openaiKey: 'old-openai-secret',
  });
  assert.equal(settings.speechModel, 'google/gemini-3.8-flash-lite-tts');
  assert.equal(settings.transcriptionModel, 'spacexai/grok-stt');
  assert.equal(
    resolveConnections(settings, {
      OPENROUTER_API_KEY: 'old-router-secret',
      OPENAI_API_KEY: 'old-openai-secret',
    }).key,
    '',
  );
  const fromEnv = resolveConnections(settings, { AI_GATEWAY_API_KEY: 'env-test-key' });
  assert.equal(fromEnv.key, 'env-test-key');
  assert.equal(fromEnv.keySource, 'environment');
  const saved = resolveConnections(
    { ...settings, gatewayKey: 'saved-test-key' },
    { AI_GATEWAY_API_KEY: 'env-test-key' },
  );
  assert.equal(saved.key, 'saved-test-key');
  assert.equal(saved.keySource, 'saved');
});

test('gateway key persists privately across restarts and unrelated edits preserve it', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'terrain-connections-'));
  try {
    const store = new ConnectionStore(directory);
    await store.load();
    await store.save({ gatewayKey: 'test-only-key', dailyLimit: 9 });
    await Promise.all([
      store.save({ speechVoice: 'Puck' }),
      store.save({ transcriptionModel: 'openai/gpt-4o-mini-transcribe' }),
    ]);
    const loaded = new ConnectionStore(directory);
    await loaded.load();
    assert.equal(loaded.get().gatewayKey, 'test-only-key');
    assert.equal(loaded.get().dailyLimit, 9);
    assert.equal(loaded.get().speechVoice, 'Puck');
    assert.equal(loaded.get().transcriptionModel, 'openai/gpt-4o-mini-transcribe');
    assert.equal((await stat(path.join(directory, 'connections.json'))).mode & 0o777, 0o600);
    const before = await readFile(path.join(directory, 'connections.json'), 'utf8');
    assert.throws(() => loaded.save({ dailyLimit: 0 }));
    assert.throws(() => loaded.save({ openaiKey: 'wrong-provider' }));
    assert.equal(await readFile(path.join(directory, 'connections.json'), 'utf8'), before);
    await loaded.save({ gatewayKey: '' });
    assert.equal(loaded.get().gatewayKey, '');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('failed connection saves never activate an unpersisted key', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'terrain-failed-connections-'));
  try {
    const blocker = path.join(directory, 'not-a-directory');
    await writeFile(blocker, 'occupied');
    const store = new ConnectionStore(blocker);
    await assert.rejects(store.save({ gatewayKey: 'test-key' }));
    assert.equal(store.get().gatewayKey, '');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('transcription uses gateway v4 JSON, not a provider multipart endpoint', async () => {
  const original = Buffer.from('browser webm test audio');
  const signal = new AbortController().signal;
  const result = await transcribeAudio({
    key: 'test-key',
    model: DEFAULT_MODELS.transcription,
    audio: original,
    mediaType: 'audio/webm;codecs=opus',
    signal,
    fetcher: (async (url, init) => {
      assert.equal(url, 'https://ai-gateway.vercel.sh/v4/ai/transcription-model');
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('Authorization'), 'Bearer test-key');
      assert.equal(headers.get('ai-gateway-protocol-version'), '0.0.1');
      assert.equal(headers.get('ai-transcription-model-specification-version'), '4');
      assert.equal(headers.get('ai-model-id'), 'spacexai/grok-stt');
      assert.equal(init?.signal, signal);
      assert.deepEqual(JSON.parse(String(init?.body)), {
        audio: original.toString('base64'),
        mediaType: 'audio/webm',
      });
      return Response.json({
        text: 'The kitchen faces the courtyard.',
        durationInSeconds: 4,
        warnings: [],
      });
    }) as typeof fetch,
  });
  assert.equal(result.text, 'The kitchen faces the courtyard.');
  assert.equal(result.cost, null);
});

test('Gemini speech uses exact model and voice and preserves the gateway WAV header', async () => {
  const original = wav();
  const result = await synthesizeSpeech({
    key: 'test-key',
    model: DEFAULT_MODELS.speech,
    text: 'Welcome home.',
    voice: 'Kore',
    fetcher: (async (url, init) => {
      assert.equal(url, 'https://ai-gateway.vercel.sh/v4/ai/speech-model');
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('ai-speech-model-specification-version'), '4');
      assert.equal(headers.get('ai-model-id'), 'google/gemini-3.8-flash-lite-tts');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.voice, 'Kore');
      assert.equal(body.text, 'Welcome home.');
      assert.equal(body.outputFormat, 'wav');
      assert.ok(body.instructions);
      return Response.json({ audio: original.toString('base64'), warnings: [] });
    }) as typeof fetch,
  });
  assert.deepEqual(result.audio, original);
  assert.equal(result.mediaType, 'audio/wav');
});

test('gateway failures expose useful status without raw provider secrets or retries', async () => {
  let calls = 0;
  await assert.rejects(
    synthesizeSpeech({
      key: 'secret-that-must-not-leak',
      model: DEFAULT_MODELS.speech,
      text: 'Hello',
      voice: 'Kore',
      fetcher: (async () => {
        calls++;
        return Response.json({ error: 'secret-that-must-not-leak' }, { status: 401 });
      }) as typeof fetch,
    }),
    (error) => {
      assert.ok(error instanceof GatewayError);
      assert.match(error.message, /401/);
      assert.doesNotMatch(error.message, /secret-that-must-not-leak/);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test('malformed gateway audio/transcripts fail safely; unknown billing is not zero', async () => {
  await assert.rejects(
    synthesizeSpeech({
      key: 'test-key',
      model: DEFAULT_MODELS.speech,
      text: 'Hello',
      voice: 'Kore',
      fetcher: (async () =>
        Response.json({ audio: Buffer.from('not audio').toString('base64') })) as typeof fetch,
    }),
    /WAV/,
  );
  await assert.rejects(
    transcribeAudio({
      key: 'test-key',
      model: DEFAULT_MODELS.transcription,
      audio: Buffer.from('audio'),
      mediaType: 'audio/wav',
      fetcher: (async () => Response.json({ text: 123 })) as typeof fetch,
    }),
  );
  assert.equal(reportedCost({}), null);
  assert.equal(reportedCost({ usage: { cost: '0.0002' } }), 0.0002);
  assert.equal(reportedCost({ providerMetadata: { gateway: { cost: '0' } } }), 0);
  assert.equal(reportedCost({ usage: { cost: 'not a number' } }), null);
  assert.equal(normalizeAudioMediaType('video/webm; codecs=opus'), 'audio/webm');
  assert.throws(() => normalizeAudioMediaType('text/html'), /Unsupported audio/);
});

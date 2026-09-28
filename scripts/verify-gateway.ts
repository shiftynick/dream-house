// Opt-in integration check. Three paid requests; never modifies the saved project.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { emptyScene, agentResponseSchema, validateScene } from '../shared/model.ts';

if (!process.argv.includes('--live')) {
  console.error(
    'Live verification uses API credits. Run npm run verify:gateway -- --live to opt in.',
  );
  process.exit(1);
}
const base = new URL(process.env.TERRAIN_BASE_URL || 'http://localhost:5173');
if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))
  throw new Error('Verification must use the local Terrain server.');
async function request(route: string, body?: unknown, contentType = 'application/json') {
  const response = await fetch(new URL(`/api/${route}`, base), {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': contentType },
    body:
      body === undefined
        ? undefined
        : Buffer.isBuffer(body)
          ? new Uint8Array(body)
          : JSON.stringify(body),
    signal: AbortSignal.timeout(100000),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(`${route}: ${data.error || response.status}`);
  }
  return response;
}
try {
  const status = await (await request('status')).json();
  assert.ok(
    status.gatewayConnected,
    'Configure AI_GATEWAY_API_KEY in .env or a saved Vercel key, then restart the server if using .env.',
  );
  assert.ok(
    status.dailyLimit - status.usage.requests >= 3,
    'At least three cloud requests must remain today.',
  );
  const before = await (await request('project')).text();
  const text = 'Make the kitchen face the courtyard, with a fireplace in the living room.';
  let start = performance.now();
  const speechResponse = await request('speak', { text });
  const audio = Buffer.from(await speechResponse.arrayBuffer());
  assert.match(speechResponse.headers.get('content-type') || '', /audio\/wav/);
  assert.equal(audio.toString('ascii', 0, 4), 'RIFF');
  assert.equal(audio.toString('ascii', 8, 12), 'WAVE');
  assert.ok(audio.length > 1000);
  console.log(
    JSON.stringify({
      check: 'speech',
      model: status.speechModel,
      voice: status.speechVoice,
      bytes: audio.length,
      seconds: +((performance.now() - start) / 1000).toFixed(2),
    }),
  );
  // Exercise the same WebM/Opus container sent by desktop browser recordings.
  const encoded = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
      '-ac',
      '1',
      '-c:a',
      'libopus',
      '-f',
      'webm',
      'pipe:1',
    ],
    { input: audio, maxBuffer: 15 * 1024 * 1024, timeout: 15000 },
  );
  const webm = !encoded.error && encoded.status === 0 && encoded.stdout.length > 100;
  const mediaType = webm ? 'audio/webm;codecs=opus' : 'audio/wav';
  start = performance.now();
  const transcript = await (
    await request('transcribe', webm ? encoded.stdout : audio, mediaType)
  ).json();
  assert.match(transcript.text, /kitchen/i);
  assert.match(transcript.text, /courtyard/i);
  assert.match(transcript.text, /fireplace/i);
  assert.match(transcript.text, /living room/i);
  console.log(
    JSON.stringify({
      check: 'transcription',
      model: status.transcriptionModel,
      mediaType,
      text: transcript.text,
      seconds: +((performance.now() - start) / 1000).toFixed(2),
    }),
  );
  start = performance.now();
  const design = agentResponseSchema.parse(
    await (
      await request('agent', {
        scene: emptyScene,
        messages: [
          {
            id: 'verification',
            role: 'user',
            text: 'Create exactly one simple rectangular living room, 6 meters wide and 5 meters deep, on a flat site. One story, limestone walls, flat roof, a glass south wall. No other rooms or stairs. Use sensible defaults and do not ask a question.',
          },
        ],
      })
    ).json(),
  );
  assert.ok(design.scene);
  validateScene(design.scene);
  assert.equal(design.scene.rooms.length, 1);
  assert.equal(design.scene.rooms[0].width, 6);
  assert.equal(design.scene.rooms[0].depth, 5);
  console.log(
    JSON.stringify({
      check: 'design',
      model: status.model,
      rooms: design.scene.rooms.length,
      seconds: +((performance.now() - start) / 1000).toFixed(2),
    }),
  );
  assert.equal(
    await (await request('project')).text(),
    before,
    'The saved house must not change during verification.',
  );
  const after = await (await request('status')).json();
  console.log(
    JSON.stringify({
      result: 'passed',
      requests: after.usage.requests - status.usage.requests,
      savedProjectUnchanged: true,
    }),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Verification failed.');
  process.exitCode = 1;
}

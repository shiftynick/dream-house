import { z } from 'zod';

export const GATEWAY_ORIGIN = 'https://ai-gateway.vercel.sh';

export class GatewayError extends Error {
  constructor(
    public operation: string,
    public status: number,
  ) {
    const guidance =
      status === 401
        ? 'The Vercel AI Gateway key was rejected. Check or replace it in Connections.'
        : status === 402
          ? 'Check your Vercel AI Gateway credits and spending limit.'
          : status === 403
            ? 'Check that your Vercel team and key have access to this model. Gateway speech access is still rolling out.'
            : status === 404
              ? 'This model or gateway capability is unavailable. Check the selected model in Connections.'
              : status === 429
                ? 'The gateway rate limit was reached. Please try again later.'
                : status === 400
                  ? 'Check the selected model, voice, and supported audio format in Connections.'
                  : 'Please try again later.';
    super(`${operation} failed through Vercel AI Gateway (${status}). ${guidance}`);
    this.name = 'GatewayError';
  }
}

export function reportedCost(body: unknown): number | null {
  if (!body || typeof body !== 'object') return null;
  const data = body as {
    usage?: { cost?: unknown };
    providerMetadata?: { gateway?: { cost?: unknown } };
  };
  const value = data.usage?.cost ?? data.providerMetadata?.gateway?.cost;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const cost = Number(value);
  return Number.isFinite(cost) && cost >= 0 ? cost : null;
}

type AudioRequest = { key: string; model: string; signal?: AbortSignal; fetcher?: typeof fetch };
async function audioRequest(kind: 'speech' | 'transcription', options: AudioRequest, body: object) {
  const response = await (options.fetcher || fetch)(`${GATEWAY_ORIGIN}/v4/ai/${kind}-model`, {
    method: 'POST',
    signal: options.signal,
    headers: {
      Authorization: `Bearer ${options.key}`,
      'Content-Type': 'application/json',
      'ai-gateway-protocol-version': '0.0.1',
      [`ai-${kind}-model-specification-version`]: '4',
      'ai-model-id': options.model,
    },
    body: JSON.stringify(body),
  });
  // Do not return provider error bodies: they can contain request metadata or credentials.
  if (!response.ok)
    throw new GatewayError(kind === 'speech' ? 'Speech output' : 'Transcription', response.status);
  return response.json();
}

export function normalizeAudioMediaType(contentType: string): string {
  const mediaType = contentType.split(';', 1)[0].trim().toLowerCase();
  const allowed = [
    'audio/webm',
    'video/webm',
    'audio/mp4',
    'video/mp4',
    'audio/mpeg',
    'audio/mp3',
    'audio/wav',
    'audio/x-wav',
    'audio/ogg',
    'audio/flac',
  ];
  if (!allowed.includes(mediaType))
    throw new Error('Unsupported audio format. Record WebM, MP4, WAV, MP3, Ogg, or FLAC audio.');
  return mediaType === 'video/webm'
    ? 'audio/webm'
    : mediaType === 'video/mp4'
      ? 'audio/mp4'
      : mediaType === 'audio/x-wav'
        ? 'audio/wav'
        : mediaType === 'audio/mp3'
          ? 'audio/mpeg'
          : mediaType;
}

export async function transcribeAudio(
  options: AudioRequest & { audio: Buffer; mediaType: string },
) {
  const mediaType = normalizeAudioMediaType(options.mediaType);
  const body = await audioRequest('transcription', options, {
    audio: options.audio.toString('base64'),
    mediaType,
  });
  const result = z
    .object({ text: z.string(), durationInSeconds: z.number().nonnegative().optional() })
    .parse(body);
  return { ...result, cost: reportedCost(body) };
}

export async function synthesizeSpeech(options: AudioRequest & { text: string; voice: string }) {
  const body = await audioRequest('speech', options, {
    text: options.text,
    voice: options.voice,
    outputFormat: 'wav',
    ...(options.model.startsWith('google/')
      ? {
          instructions:
            'Speak calmly and naturally, like a thoughtful architectural design partner.',
        }
      : {}),
  });
  const result = z.object({ audio: z.string().min(1).max(40_000_000) }).parse(body);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(result.audio))
    throw new Error(
      'The gateway returned invalid speech audio. The written reply is still available.',
    );
  const audio = Buffer.from(result.audio, 'base64');
  // Gemini provides a complete WAV. Never wrap it in a second RIFF header.
  if (
    audio.length < 44 ||
    audio.toString('ascii', 0, 4) !== 'RIFF' ||
    audio.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error(
      'The gateway did not return playable WAV audio. The written reply is still available.',
    );
  }
  return { audio, mediaType: 'audio/wav', cost: reportedCost(body) };
}

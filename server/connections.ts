import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  DEFAULT_MODELS,
  DEFAULT_SPEECH_VOICE,
  DEFAULT_CODEX_MODEL,
  CODEX_MODEL_IDS,
} from '../shared/connections.ts';

const modelId = z
  .string()
  .trim()
  .min(3)
  .max(160)
  .regex(/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._:-]+$/);
export const connectionFields = {
  gatewayKey: z.string().trim().max(1000),
  model: modelId,
  speechModel: modelId,
  transcriptionModel: modelId,
  speechVoice: z.string().trim().min(1).max(100),
  dailyLimit: z.number().int().min(1).max(1000),
  codexModel: z.enum(CODEX_MODEL_IDS),
};
export const connectionPatchSchema = z.object(connectionFields).partial().strict();
export const connectionSettingsSchema = z.object({
  gatewayKey: connectionFields.gatewayKey.default(''),
  model: modelId.default(DEFAULT_MODELS.design),
  speechModel: modelId.default(DEFAULT_MODELS.speech),
  transcriptionModel: modelId.default(DEFAULT_MODELS.transcription),
  speechVoice: connectionFields.speechVoice.default(DEFAULT_SPEECH_VOICE),
  dailyLimit: connectionFields.dailyLimit.default(60),
  codexModel: connectionFields.codexModel.optional(),
});
export type ConnectionSettings = z.infer<typeof connectionSettingsSchema>;

/** Local testing switches never overwrite saved Gateway credentials/models. */
export function resolveTestingBackend(env: NodeJS.ProcessEnv) {
  return {
    designBackend: z.enum(['gateway', 'codex-cli']).parse(env.DESIGN_BACKEND?.trim() || 'gateway'),
    codexModel: z.enum(CODEX_MODEL_IDS).parse(env.CODEX_MODEL?.trim() || DEFAULT_CODEX_MODEL),
    codexBinary: env.CODEX_BINARY?.trim() || 'codex',
    voiceEnabled: z.enum(['true', 'false']).parse(env.VOICE_ENABLED?.trim() || 'false') === 'true',
  };
}

export function resolveConnections(
  settings: ConnectionSettings,
  env: NodeJS.ProcessEnv = process.env,
) {
  const environmentKey = env.AI_GATEWAY_API_KEY?.trim() || '';
  return {
    key: settings.gatewayKey || environmentKey,
    keySource: settings.gatewayKey
      ? ('saved' as const)
      : environmentKey
        ? ('environment' as const)
        : ('none' as const),
    model: env.AI_GATEWAY_MODEL?.trim() || settings.model,
    speechModel: env.AI_GATEWAY_SPEECH_MODEL?.trim() || settings.speechModel,
    transcriptionModel: env.AI_GATEWAY_TRANSCRIPTION_MODEL?.trim() || settings.transcriptionModel,
    speechVoice: env.AI_GATEWAY_SPEECH_VOICE?.trim() || settings.speechVoice,
  };
}

export class ConnectionStore {
  private settings = connectionSettingsSchema.parse({});
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private directory: string) {}
  async load() {
    try {
      // Legacy provider keys are intentionally not repurposed as gateway credentials.
      this.settings = connectionSettingsSchema.parse(
        JSON.parse(await readFile(path.join(this.directory, 'connections.json'), 'utf8')),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  get() {
    return this.settings;
  }
  save(input: unknown): Promise<void> {
    const patch = connectionPatchSchema.parse(input);
    const job = this.queue
      .catch(() => {})
      .then(async () => {
        const next = connectionSettingsSchema.parse({ ...this.settings, ...patch });
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const file = path.join(this.directory, 'connections.json');
        await writeFile(file + '.tmp', JSON.stringify(next), { mode: 0o600 });
        await chmod(file + '.tmp', 0o600);
        await rename(file + '.tmp', file);
        // Only activate a key after it has been successfully persisted.
        this.settings = next;
      });
    this.queue = job;
    return job;
  }
}

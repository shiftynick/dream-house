// Public defaults only. Credentials belong exclusively to the local server.
export const DEFAULT_MODELS = {
  design: 'anthropic/claude-sonnet-5.5',
  speech: 'google/gemini-3.8-flash-lite-tts',
  transcription: 'spacexai/grok-stt',
} as const;
export const DEFAULT_SPEECH_VOICE = 'Kore';
export const DEFAULT_CODEX_MODEL = 'gpt-6.1-sol';
export const CODEX_MODEL_IDS = ['gpt-6.1-sol', 'gpt-6-astra'] as const;
export type CodexModel = (typeof CODEX_MODEL_IDS)[number];
export const CODEX_MODELS = {
  'gpt-6.1-sol': { label: 'Sol 6.1', reasoningEffort: 'medium' },
  'gpt-6-astra': { label: 'Astra', reasoningEffort: 'high' },
} as const;
export type CodexReasoningEffort = (typeof CODEX_MODELS)[CodexModel]['reasoningEffort'];

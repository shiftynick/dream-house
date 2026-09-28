// Public defaults only. Credentials belong exclusively to the local server.
export const DEFAULT_MODELS = {
  design: 'openai/gpt-4.1-mini',
  speech: 'google/gemini-3.8-flash-lite-tts',
  transcription: 'spacexai/grok-stt',
} as const;
export const DEFAULT_SPEECH_VOICE = 'Kore';

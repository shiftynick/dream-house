import type { CodexModel } from '../shared/connections';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    ...options,
    headers: {
      ...(options.body && typeof options.body === 'string'
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...options.headers,
    },
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new ApiError(
      data.error || `Request failed (${response.status}).`,
      response.status,
      data.code,
    );
  }
  return response.json() as Promise<T>;
}
export type Status = {
  gatewayConnected: boolean;
  keySource: 'saved' | 'environment' | 'none';
  modelConnected: boolean;
  voiceConnected: boolean;
  voiceEnabled: boolean;
  designBackend: 'gateway' | 'codex-cli';
  codexModel: CodexModel;
  reasoningEffort: 'medium' | 'high' | null;
  gatewayModel: string;
  model: string;
  speechModel: string;
  transcriptionModel: string;
  speechVoice: string;
  dailyLimit: number;
  usage: { day: string; requests: number; modelCost: number };
};

export type ProjectSummary = { id: string; name: string; revision: number; rooms: number };
export type ProjectDirectory = { activeProjectId: string; projects: ProjectSummary[] };

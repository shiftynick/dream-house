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
    throw new Error(data.error || `Request failed (${response.status}).`);
  }
  return response.json() as Promise<T>;
}
export type Status = {
  gatewayConnected: boolean;
  keySource: 'saved' | 'environment' | 'none';
  modelConnected: boolean;
  voiceConnected: boolean;
  model: string;
  speechModel: string;
  transcriptionModel: string;
  speechVoice: string;
  dailyLimit: number;
  usage: { day: string; requests: number; modelCost: number };
};

import type { ModelMessage } from './agent.ts';

/** Keep protocol pairings and operation evidence; the live system snapshot owns geometry. */
export function compactAgentHistory(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (message.role !== 'tool' || typeof message.content !== 'string') return message;
    let result: Record<string, unknown>;
    try {
      result = JSON.parse(message.content);
    } catch {
      return message;
    }
    if (!result || typeof result !== 'object' || !('scene' in result || 'inspection' in result))
      return message;
    const { scene: _scene, inspection: _inspection, ...evidence } = result;
    return {
      ...message,
      content: JSON.stringify({
        ...evidence,
        snapshot:
          'The current exact geometry, relationships, and validation issues are in the live working-house system message.',
      }),
    };
  });
}

/** Retain explicitly current capture pixels; retired hash/view provenance stays in history. */
export function retireReviewedImages(
  messages: ModelMessage[],
  keepMessages = new Set<ModelMessage>(),
): void {
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    if (keepMessages.has(message) || !message.content.some((part) => part.type === 'image_url'))
      continue;
    message.content = message.content.filter((part) => part.type !== 'image_url');
    message.content.push({
      type: 'text',
      text: 'These image pixels are no longer current review evidence and are omitted from subsequent calls. The view metadata remains; request render_view if another image is necessary.',
    });
  }
}

export function historySize(messages: ModelMessage[]) {
  let imageBytes = 0;
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === 'image_url')
        imageBytes += Math.floor((part.image_url.url.split(',')[1]?.length || 0) * 0.75);
    }
  }
  return { characters: JSON.stringify(messages).length, imageBytes };
}

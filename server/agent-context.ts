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

/** Pixels are sent for their review round only. Their hash/view provenance remains in history. */
export function retireReviewedImages(messages: ModelMessage[]): void {
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    if (!message.content.some((part) => part.type === 'image_url')) continue;
    message.content = message.content.filter((part) => part.type !== 'image_url');
    message.content.push({
      type: 'text',
      text: 'Image pixels were supplied in an earlier model call and are omitted from subsequent calls to avoid repeated image charges. The view metadata remains; request render_view if another image is necessary.',
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

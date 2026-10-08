import type { ModelMessage } from './agent.ts';

const snapshotTools = new Set(['apply_operations', 'inspect_design', 'reset_draft']);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Compact historical geometry only after the caller has refreshed its authoritative snapshot.
 * The newest assistant tool turn remains verbatim, including all its tool responses.
 * Review/checklist/provenance payloads and unknown tool results are never compacted.
 * This creates a provider-bound view; it does not mutate the recorded protocol history.
 */
export function compactStaleToolResults(
  messages: ModelMessage[],
  options: { authoritativeSnapshotAvailable: boolean },
): ModelMessage[] {
  if (!options.authoritativeSnapshotAvailable) return messages;
  const owners = new Map<string, { name: string; index: number }>();
  const ambiguous = new Set<string>();
  let latestToolTurn = -1;
  messages.forEach((message, index) => {
    if (message.role !== 'assistant' || !message.tool_calls?.length) return;
    latestToolTurn = index;
    for (const call of message.tool_calls) {
      if (owners.has(call.id)) ambiguous.add(call.id);
      owners.set(call.id, { name: call.function.name, index });
    }
  });
  return messages.map((message, index) => {
    if (message.role !== 'tool' || typeof message.content !== 'string' || !message.tool_call_id)
      return message;
    const owner = owners.get(message.tool_call_id);
    if (
      !owner ||
      ambiguous.has(message.tool_call_id) ||
      owner.index >= index ||
      owner.index === latestToolTurn ||
      !snapshotTools.has(owner.name)
    )
      return message;
    let result: unknown;
    try {
      result = JSON.parse(message.content);
    } catch {
      return message;
    }
    if (!record(result)) return message;
    const omitted: string[] = [];
    const compact = { ...result };
    for (const field of ['scene', 'inspection', 'quality']) {
      // Unexpected payload types remain available rather than guessing their semantics.
      if (!record(result[field])) continue;
      const payload = result[field];
      // Inspection issues and quality caveats are historical evidence, not replaceable geometry.
      if (field === 'inspection' && payload.issues !== undefined) {
        if ('historicalInspectionIssues' in compact) continue;
        compact.historicalInspectionIssues = payload.issues;
      }
      if (field === 'quality' && payload.limitations !== undefined) {
        if ('historicalQualityLimitations' in compact) continue;
        compact.historicalQualityLimitations = payload.limitations;
      }
      delete compact[field];
      omitted.push(field);
    }
    if (!omitted.length) return message;
    // Keep any existing application note; the compaction marker has its own reserved key.
    if ('historicalSnapshotOmitted' in result) return message;
    compact.historicalSnapshotOmitted = {
      fields: omitted,
      reason:
        'Historical geometry is omitted; current geometry, quality and validation are in the refreshed authoritative snapshot. Retained issues and changes describe this earlier operation.',
    };
    return { ...message, content: JSON.stringify(compact) };
  });
}

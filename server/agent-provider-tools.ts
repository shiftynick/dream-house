import { z } from 'zod';
import { designCritiqueSchema } from './design-planning.ts';

export type ProviderTool = { name: string; description: string; schema: z.ZodType };
export type ProviderPhase = 'empty-site' | 'composition-review';

/** The same phase and immutable critic constraints apply to every provider. */
export function providerTools(
  tools: readonly ProviderTool[],
  names?: string[],
  objectiveIds?: string[],
  phase?: ProviderPhase,
): ProviderTool[] {
  const finish = tools.find((tool) => tool.name === 'finish_design')!.schema as z.ZodObject;
  const criticOnly = names?.length === 1 && names[0] === 'submit_design_critique';
  const validManifest =
    criticOnly &&
    objectiveIds &&
    objectiveIds.length >= 1 &&
    objectiveIds.length <= 12 &&
    new Set(objectiveIds).size === objectiveIds.length &&
    objectiveIds.every((id) => typeof id === 'string' && id.length >= 1 && id.length <= 60);
  const criticSchema = validManifest
    ? designCritiqueSchema.extend({
        observations: z
          .array(
            designCritiqueSchema.shape.observations.element.extend({
              objectiveId: z.enum(objectiveIds),
            }),
          )
          .length(objectiveIds.length),
      })
    : designCritiqueSchema;
  const definitions: ProviderTool[] = tools.map((tool) => {
    let schema = tool.schema;
    if (phase === 'empty-site' && tool.name === 'finish_design')
      schema = z
        .object({
          reply: finish.shape.reply,
          mode: z.literal('question'),
          questionReason: z.literal('clarification'),
        })
        .strict();
    if (phase === 'composition-review' && tool.name === 'finish_design')
      schema = finish.extend({ assessment: z.literal('canonical') });
    if (phase === 'composition-review' && tool.name === 'review_design')
      schema = z.object({ assessment: z.literal('canonical') }).strict();
    return { ...tool, schema };
  });
  definitions.push({
    name: 'submit_design_critique',
    description:
      'Submit a skeptical per-objective critique of the design and adequacy against the original request. Report specific targeted repairs and missing objectives; never edit the design.',
    schema: criticSchema,
  });
  return names
    ? definitions.filter((tool) => names.includes(tool.name))
    : definitions.filter((tool) => tool.name !== 'submit_design_critique');
}

export function providerToolDefinitions(tools: readonly ProviderTool[]) {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: z.toJSONSchema(tool.schema, { target: 'draft-7' }),
    },
  }));
}

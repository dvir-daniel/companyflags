// Templates in New flag (Flags.tsx): a ready flag to start from. "AI config": a JSON flag with the model, the prompt and
// the settings of an AI feature, two variants to compare, and a JSON Schema (server/jsonSchema.ts) so no value can lose
// a field. No React here, so the Node tests load it.

import { schemaProblem, type JsonSchema } from '../../../server/jsonSchema.ts';

export const AI_CONFIG_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    model: { type: 'string', minLength: 1, description: 'The model to call' },
    temperature: { type: 'number', minimum: 0, maximum: 2 },
    prompt: { type: 'string', description: 'The system prompt' },
    tools: { type: 'array', items: { type: 'string' }, description: 'The tools the model may use' },
  },
  required: ['model'],
  additionalProperties: false,
};

export type FlagTemplate = {
  valueType: 'json';
  kind: string;
  description: string;
  variants: { key: string; value: unknown }[];
  defaultVariation: string;
  jsonSchema: JsonSchema;
};

/** The AI config template for a feature named `name` (what was typed in Name; it may be empty). */
export function aiConfigTemplate(name: string): FlagTemplate {
  const what = name.trim() || 'this AI feature';
  return {
    valueType: 'json',
    kind: 'config',
    description: `The model, prompt and settings for ${what}.`,
    variants: [
      { key: 'fast', value: { model: 'small-model', temperature: 0.2, prompt: 'Answer in two or three short sentences.' } },
      { key: 'strong', value: { model: 'large-model', temperature: 0.7, prompt: 'Think the question through, then answer clearly.', tools: ['search'] } },
    ],
    defaultVariation: 'fast',
    jsonSchema: AI_CONFIG_SCHEMA,
  };
}

/** A schema as the console's textarea shows it. */
export const schemaText = (schema: JsonSchema | null | undefined) => (schema ? JSON.stringify(schema, null, 2) : '');

/** The schema typed into the textarea: null when it's empty, or what's wrong with it. */
export function readSchemaText(text: string): { schema: JsonSchema | null; error: string | null } {
  if (!text.trim()) return { schema: null, error: null };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { schema: null, error: 'Not valid JSON' }; }
  const p = schemaProblem(parsed);
  return p ? { schema: null, error: p } : { schema: parsed as JsonSchema, error: null };
}

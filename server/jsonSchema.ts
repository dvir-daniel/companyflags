// A JSON flag's JSON Schema (migration 0016): every value it can serve must match it, so a config (a model, a prompt,
// its settings) can't lose a field. One pure module, shared with the console (like checks.ts), so the console's
// warning and the server's 422 say the same thing.
//
// A practical subset of JSON Schema, with no dependency: type (object, array, string, number, integer, boolean, null,
// or a list of them), properties, required, additionalProperties (true or false), items, enum, minimum, maximum,
// minLength and maxLength. Notes for people (title, description, $schema, $comment, default, examples) are kept and
// change nothing. Any other keyword is refused, so a schema never seems to check something it doesn't.

export type JsonSchema = {
  type?: SchemaType | SchemaType[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  title?: string;
  description?: string;
};

export const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'] as const;
export type SchemaType = (typeof SCHEMA_TYPES)[number];
const CHECKS = ['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'minimum', 'maximum', 'minLength', 'maxLength'];
const NOTES = ['title', 'description', '$schema', '$comment', 'default', 'examples'];
/** The keywords a schema may use, in words for the error that names one it can't. */
export const SUPPORTED_KEYWORDS = CHECKS.join(', ');
/** A schema's size limit, written out as JSON. */
export const SCHEMA_MAX_CHARS = 64_000;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;
const join = (path: string, key: string) => (path ? `${path}.${key}` : key);
const same = (a: unknown, b: unknown) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted)
  : isObject(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v;

/** What's wrong with a schema (null when it's one this module can check). "at properties.model" says where. */
export function schemaProblem(schema: unknown): string | null {
  if (JSON.stringify(schema ?? null).length > SCHEMA_MAX_CHARS) return `The JSON Schema is too long (up to ${SCHEMA_MAX_CHARS / 1000} KB)`;
  return problemAt(schema, '');
}

function problemAt(s: unknown, where: string): string | null {
  const at = where ? ` (at ${where})` : '';
  if (!isObject(s)) return `A JSON Schema is an object, like { "type": "object" }${at}`;
  for (const k of Object.keys(s)) {
    if (!CHECKS.includes(k) && !NOTES.includes(k)) return `“${k}” isn’t supported${at}. A schema can use ${SUPPORTED_KEYWORDS}`;
  }
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    const bad = types.find((t) => !SCHEMA_TYPES.includes(t as SchemaType));
    if (!types.length || bad !== undefined) return `type is one of ${SCHEMA_TYPES.join(', ')}${at}`;
  }
  if (s.properties !== undefined) {
    if (!isObject(s.properties)) return `properties is an object: field → its schema${at}`;
    for (const [k, sub] of Object.entries(s.properties)) {
      const p = problemAt(sub, join(where, `properties.${k}`));
      if (p) return p;
    }
  }
  if (s.required !== undefined && (!Array.isArray(s.required) || s.required.some((r) => typeof r !== 'string') || new Set(s.required).size !== s.required.length)) {
    return `required is a list of field names, each once${at}`;
  }
  if (s.additionalProperties !== undefined && typeof s.additionalProperties !== 'boolean') {
    return `additionalProperties is true or false${at} (a schema for the other fields isn’t supported)`;
  }
  if (s.items !== undefined) {
    const p = problemAt(s.items, join(where, 'items'));
    if (p) return p;
  }
  if (s.enum !== undefined && (!Array.isArray(s.enum) || !s.enum.length)) return `enum is a list of the values allowed${at}`;
  for (const k of ['minimum', 'maximum'] as const) {
    if (s[k] !== undefined && (typeof s[k] !== 'number' || !Number.isFinite(s[k]))) return `${k} is a number${at}`;
  }
  for (const k of ['minLength', 'maxLength'] as const) {
    if (s[k] !== undefined && !isCount(s[k])) return `${k} is a whole number, 0 or more${at}`;
  }
  if (typeof s.minimum === 'number' && typeof s.maximum === 'number' && s.minimum > s.maximum) return `minimum is above maximum${at}`;
  if (isCount(s.minLength) && isCount(s.maxLength) && (s.minLength as number) > (s.maxLength as number)) return `minLength is above maxLength${at}`;
  return null;
}

const typeOf = (v: unknown): SchemaType => v === null ? 'null' : Array.isArray(v) ? 'array'
  : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : (typeof v as SchemaType);
const fits = (v: unknown, t: SchemaType) => typeOf(v) === t || (t === 'number' && typeOf(v) === 'integer');
const article = (t: string) => (/^[aeiou]/.test(t) ? `an ${t}` : `a ${t}`);
const typeWords = (types: SchemaType[]) => types.map((t) => (t === 'null' ? 'null' : t === 'boolean' ? 'true or false' : article(t))).join(' or ');

/** What's wrong with a value under a valid schema, first problem first: "model is required", "tools[0] must be a
 *  string". Empty when it matches. */
export function valueProblems(schema: JsonSchema, value: unknown): string[] {
  const out: string[] = [];
  check(schema, value, '', out);
  return out;
}

function check(s: JsonSchema, v: unknown, path: string, out: string[]) {
  const what = path || 'the value';
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some((t) => fits(v, t))) { out.push(`${what} must be ${typeWords(types)}`); return; }
  }
  if (s.enum && !s.enum.some((e) => same(e, v))) out.push(`${what} must be one of ${s.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  if (typeof v === 'number') {
    if (s.minimum !== undefined && v < s.minimum) out.push(`${what} must be at least ${s.minimum}`);
    if (s.maximum !== undefined && v > s.maximum) out.push(`${what} must be at most ${s.maximum}`);
  }
  if (typeof v === 'string') {
    const n = [...v].length;
    if (s.minLength !== undefined && n < s.minLength) out.push(`${what} must be at least ${s.minLength} character${s.minLength === 1 ? '' : 's'} long`);
    if (s.maxLength !== undefined && n > s.maxLength) out.push(`${what} must be at most ${s.maxLength} character${s.maxLength === 1 ? '' : 's'} long`);
  }
  if (isObject(v)) {
    for (const r of s.required ?? []) if (!Object.hasOwn(v, r)) out.push(`${join(path, r)} is required`);
    for (const [k, sub] of Object.entries(v)) {
      const known = s.properties && Object.hasOwn(s.properties, k);
      if (known) check(s.properties![k], sub, join(path, k), out);
      else if (s.additionalProperties === false) out.push(`${join(path, k)} isn’t in the schema`);
    }
  }
  if (Array.isArray(v) && s.items) v.forEach((x, i) => check(s.items!, x, path ? `${path}[${i}]` : `item ${i + 1}`, out));
}

/** The first value that doesn't match, as the server refuses it: "fast: model is required". `name` says which value
 *  each is (a variant's key, or the typed value itself for a free value). */
export function firstMismatch(schema: JsonSchema, values: readonly { key: string; value: unknown }[], name: (v: { key: string; value: unknown }) => string = (v) => v.key): string | null {
  for (const v of values) {
    const p = valueProblems(schema, v.value)[0];
    if (p) return `${name(v)}: ${p}`;
  }
  return null;
}

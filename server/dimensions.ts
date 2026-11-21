// What an installation serves config per (docs/content/docs/guide/dimensions.mdx): its dimensions, one chain from the top down, at
// most four ("region › chain › store", "company › brand", or just "customer"). Each dimension has a key (a rule
// attribute, stored in rules, fixed once used) and the words people read. Its entries are entities (`acme-12`).
// Pure: the server checks the chain with it before saving, and the console builds its sentences with it.

export type Dimension = { key: string; singular: string; plural: string };
/** Top to bottom: each dimension's parent is the one before it. */
export type Dimensions = readonly Dimension[];

export const MAX_DIMENSIONS = 4;
export const DIMENSION_KEY = /^[a-z][a-z0-9_]{0,29}$/;
const WORD = /^[\p{L}\p{M}](?:[\p{L}\p{M} '’-]{0,28}[\p{L}\p{M}])?$/u;

/** The attribute that is exactly the entity asking, at whatever level (fields.ts). */
export const ENTITY_FIELD = 'entity';
/** No dimension may take these: the entity attribute, and the names or first parts of the built-in attributes. */
export const RESERVED_DIMENSION_KEYS: ReadonlySet<string> = new Set([ENTITY_FIELD, 'project', 'environment', 'app', 'device', 'session', 'geo', 'locale']);

/** Problems with a chain of dimensions, in words; none means it can be saved. */
export function checkDimensions(dims: Dimensions): string[] {
  const errors: string[] = [];
  if (dims.length > MAX_DIMENSIONS) errors.push(`At most ${MAX_DIMENSIONS} dimensions`);
  const keys = new Set<string>();
  const singulars = new Set<string>();
  const plurals = new Set<string>();
  dims.forEach((d, i) => {
    const at = `Dimension ${i + 1}`;
    if (!DIMENSION_KEY.test(d.key ?? '')) errors.push(`${at}: the key uses lowercase letters, digits and _, starts with a letter, and has at most 30 characters`);
    else if (RESERVED_DIMENSION_KEYS.has(d.key)) errors.push(`${at}: “${d.key}” is a reserved word: pick another key`);
    else if (keys.has(d.key)) errors.push(`${at}: the key “${d.key}” is used twice`);
    keys.add(d.key);
    for (const [word, label] of [[d.singular, 'singular'], [d.plural, 'plural']] as const) {
      if (!WORD.test((word ?? '').trim())) errors.push(`${at}: the ${label} has 1–30 letters, spaces, hyphens or apostrophes`);
    }
    const s = (d.singular ?? '').trim().toLocaleLowerCase();
    const p = (d.plural ?? '').trim().toLocaleLowerCase();
    if (s && singulars.has(s)) errors.push(`${at}: another dimension is called “${d.singular}” already`);
    if (p && plurals.has(p)) errors.push(`${at}: another dimension’s plural is “${d.plural}” already`);
    singulars.add(s);
    plurals.add(p);
  });
  return errors;
}

/** Words as typed, without the spaces around them. */
export const cleanDimension = (d: Dimension): Dimension => ({ key: d.key, singular: d.singular.trim(), plural: d.plural.trim() });

/** A key suggested from the singular: "Sub-account" → "sub_account". */
export function suggestKey(singular: string): string {
  const k = singular.trim().toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const key = /^[a-z]/.test(k) ? k.slice(0, 30) : `d_${k}`.slice(0, 30);
  return key === 'd_' ? '' : key;
}

// ---- words ------------------------------------------------------------------------------------
// Written as in the middle of a sentence ("store"), capitalized for titles ("Stores"). Never "a" or "an" before one
// (the article depends on the word), never a plural made by adding "s", never a word pasted into a longer one.

export const capital = (w: string) => (w ? w[0].toLocaleUpperCase() + w.slice(1) : w);
/** "store" */
export const one = (d: Dimension) => d.singular;
/** "stores" */
export const many = (d: Dimension) => d.plural;
/** "Stores" (or "Store" with `plural` false) */
export const title = (d: Dimension, plural = true) => capital(plural ? d.plural : d.singular);
/** "1 store", "3 stores" */
export const count = (d: Dimension, n: number) => `${n} ${n === 1 ? d.singular : d.plural}`;
/** "Acme’s" */
export const own = (name: string) => `${name}’s`;
/** The singulars joined: "Region, chain or store" (`and`: "Region, chain and store"). Empty for no dimensions. */
export function joined(dims: Dimensions, word: 'or' | 'and' = 'or'): string {
  const w = dims.map((d) => d.singular);
  if (w.length === 0) return '';
  const text = w.length === 1 ? w[0] : `${w.slice(0, -1).join(', ')} ${word} ${w[w.length - 1]}`;
  return capital(text);
}
export const dimensionOf = (dims: Dimensions, key: string | null | undefined) => dims.find((d) => d.key === key);
/** The dimension right below one (null: it's the bottom, or isn't there). */
export const below = (dims: Dimensions, key: string) => { const i = dims.findIndex((d) => d.key === key); return i >= 0 ? dims[i + 1] ?? null : null; };
/** The dimension right above one (null: it's the top, or isn't there). */
export const above = (dims: Dimensions, key: string) => { const i = dims.findIndex((d) => d.key === key); return i > 0 ? dims[i - 1] : null; };

/** Ready-made chains for a new installation. */
export const PRESETS: { name: string; dimensions: Dimension[] }[] = [
  { name: 'Customers', dimensions: [{ key: 'customer', singular: 'customer', plural: 'customers' }] },
  { name: 'Companies › Brands', dimensions: [{ key: 'company', singular: 'company', plural: 'companies' }, { key: 'brand', singular: 'brand', plural: 'brands' }] },
  { name: 'Accounts › Sub-accounts', dimensions: [{ key: 'account', singular: 'account', plural: 'accounts' }, { key: 'sub_account', singular: 'sub-account', plural: 'sub-accounts' }] },
  { name: 'Regions › Chains › Stores', dimensions: [{ key: 'region', singular: 'region', plural: 'regions' }, { key: 'chain', singular: 'chain', plural: 'chains' }, { key: 'store', singular: 'store', plural: 'stores' }] },
  { name: 'Organizations › Workspaces', dimensions: [{ key: 'organization', singular: 'organization', plural: 'organizations' }, { key: 'workspace', singular: 'workspace', plural: 'workspaces' }] },
];

/** Orders dimension rows (each naming its parent) top to bottom. Rows not reached from the top are left out. */
export function chainOrder<T extends { key: string; parent: string | null }>(rows: readonly T[]): T[] {
  const byParent = new Map(rows.map((r) => [r.parent, r]));
  const out: T[] = [];
  let next = byParent.get(null);
  while (next && out.length < rows.length) { out.push(next); next = byParent.get(next.key); }
  return out;
}

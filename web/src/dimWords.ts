// The console's small helpers for this installation's dimensions (server/dimensions.ts): their words in a sentence and
// the address of an entity's page. A .ts file, so pages can share them (.tsx files export only components).
import { dimensionOf, entityIndex, fieldLabel, type Dimensions, type Entity } from './api.ts';

/** The singulars joined, as in the middle of a sentence: "company or brand", "region, chain and store". */
export function listWords(dims: Dimensions, word: 'or' | 'and' = 'or', plural = false): string {
  const w = dims.map((d) => (plural ? d.plural : d.singular));
  return w.length <= 1 ? w.join('') : `${w.slice(0, -1).join(', ')} ${word} ${w[w.length - 1]}`;
}

/** The title of the flag page's own-settings panel: "Per company or brand"; "Own settings" with no dimensions. */
export const perWho = (dims: Dimensions) => (dims.length ? `Per ${listWords(dims)}` : 'Own settings');

/** An entity's page, as an address for go() (no "#/"): "dimensions/store/acme-12/prod". null when it isn't known. */
export function entityPath(entities: Entity[], key: string, env?: string, view?: string): string | null {
  const e = entityIndex(entities).get(key);
  if (!e) return null;
  return ['dimensions', e.dimension, encodeURIComponent(key), ...(env ? [env] : []), ...(env && view ? [view] : [])].join('/');
}

/** The dimension's plural for a count of its entities ("3 stores"), or a count of entries in several dimensions. */
export function plurals(dims: Dimensions, entities: Entity[], keys: readonly string[]): string {
  const byKey = entityIndex(entities);
  const per = new Map<string, number>();
  for (const k of keys) { const d = byKey.get(k)?.dimension ?? ''; per.set(d, (per.get(d) ?? 0) + 1); }
  return [...per].map(([d, n]) => { const dim = dimensionOf(dims, d); return dim ? `${n.toLocaleString()} ${n === 1 ? dim.singular : dim.plural}` : `${n.toLocaleString()} more`; }).join(', ');
}

/** The attributes an entity's own rules can't vary on: its dimension and those above it (always its own and its
 *  parents'), and `entity` itself when nothing is under it. The dimensions below
 *  stay: its rules apply to the entities under it that follow it ("Store is Acme 12" in a chain's own settings). */
export function settledAt(dims: Dimensions, entities: Entity[], key: string): Set<string> {
  const e = entityIndex(entities).get(key);
  const at = e ? dims.findIndex((d) => d.key === e.dimension) : -1;
  const out = new Set<string>();
  dims.forEach((d, i) => { if (i <= at) out.add(d.key); });
  if (at === dims.length - 1) out.add('entity');
  return out;
}

/** What saving an entity's own settings on a flag also changes: "This also changes what 240 stores get, as they follow
 *  Acme on this flag." (the dimension right below), or "… what 12 entries under it get, …" across several. null when
 *  nothing follows it. */
export function followingText(dims: Dimensions, dimension: string, n: number, name: string): string | null {
  if (!n) return null;
  const i = dims.findIndex((d) => d.key === dimension);
  const under = i >= 0 ? dims.slice(i + 1) : [];
  const words = under.length === 1 ? `${n.toLocaleString()} ${n === 1 ? under[0].singular : under[0].plural}` : `${n.toLocaleString()} ${n === 1 ? 'entry' : 'entries'} under it`;
  return `This also changes what ${words} get${n === 1 ? 's' : ''}, as ${n === 1 ? 'it follows' : 'they follow'} ${name} on this flag.`;
}

/** What a % is out of, in the plural: "device ids"; for a split by a dimension, its own plural ("companies"). */
export function unitPlural(field: string, dims: Dimensions): string {
  const d = dimensionOf(dims, field);
  if (d) return d.plural;
  if (field === 'entity' && dims.length) return listWords(dims, 'or', true);
  return `${fieldLabel(field, dims).toLowerCase()}s`;
}

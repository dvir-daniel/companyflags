// What the entity picker (EntityPicker in flagParts.tsx) finds for what's typed. Entities are told apart by key: two
// can share a name ("Main store" under Lumen and under Bolt), so a name alone never picks one.
import type { Entity } from '../api.ts';

/** At most this many matches are listed: typing narrows them. */
export const PICK_LIMIT = 50;

/** An entity with what it's found by, in lower case: its name, its key, and its label ("Main store (Bolt)"). */
export type Searchable = { entity: Entity; name: string; key: string; label: string };

/** Ready to search: built once per list (not per keystroke). `labelOf` names an entity with its parent. */
export function searchable(list: Entity[], labelOf: (e: Entity) => string): Searchable[] {
  return list.map((e) => ({ entity: e, name: e.name.toLowerCase(), key: e.key.toLowerCase(), label: labelOf(e).toLowerCase() }));
}

/**
 * The entities that match `query` by name, key or label (any case), best first: an exact match, then those that start
 * with it, then those that have it anywhere; in list order within each. At most `limit`; `total` is how many match.
 * An empty query lists the first `limit`.
 */
export function searchEntities(list: Searchable[], query: string, limit = PICK_LIMIT): { items: Entity[]; total: number } {
  const q = query.trim().toLowerCase();
  if (!q) return { items: list.slice(0, limit).map((s) => s.entity), total: list.length };
  const tiers: Entity[][] = [[], [], []];
  let total = 0;
  for (const s of list) {
    const tier = s.key === q || s.name === q || s.label === q ? 0
      : s.key.startsWith(q) || s.name.startsWith(q) || s.label.startsWith(q) ? 1
      : s.key.includes(q) || s.name.includes(q) || s.label.includes(q) ? 2 : -1;
    if (tier < 0) continue;
    total++;
    // a tier needs no more than `limit`: the better tiers come first
    if (tiers[tier].length < limit) tiers[tier].push(s.entity);
  }
  return { items: tiers.flat().slice(0, limit), total };
}

/**
 * The one entity what's typed names exactly, without picking from the list: its key, else its label, else its name
 * (any case). Null when it names none, or more than one (two "Main store"s: pick one from the list).
 */
export function resolveTyped(list: Searchable[], text: string): Entity | null {
  const q = text.trim().toLowerCase();
  if (!q) return null;
  for (const field of ['key', 'label', 'name'] as const) {
    let hit: Entity | null = null;
    let many = false;
    for (const s of list) {
      if (s[field] !== q) continue;
      if (hit) { many = true; break; }
      hit = s.entity;
    }
    if (many) return null;
    if (hit) return hit;
  }
  return null;
}

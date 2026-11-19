import { useState } from 'react';
import { entityIndex, KIND_INFO, type AnswerPick, type Dimension, type EntityAnswer, type EntityWords, type Inherit, type LevelName, type Meta } from '../api.ts';
import type { Paged } from '../uiKit.ts';

/* What the entity pages (Entities.tsx, entityParts.tsx, childrenGrid.tsx, entityTree.tsx) share: the server's shapes
   (server/api.ts, the /dimensions routes) and the small helpers that read them. Kept out of the .tsx files, which
   export only components (Fast Refresh). */

/** One entity in a dimension's list: how many flags it has its own settings on, per environment, and how many
 *  entities are right under it. */
export type EntityRow = {
  key: string; name: string; dimension: string; parent: string | null; parentName: string | null; children: number; createdAt: string;
  flagsWithSettings: Record<string, number>;
};

// The entity chain for one flag, as the server reads it (server/evaluator.ts entityChain): overrides for everyone, its
// own settings, those of each entity above it, then everyone's. `skippedBy`: the entity below whose "Own settings only"
// passes this level over. `defaultWins`: the chain ends in this level's default when no rule decides.
export type Level = {
  who: LevelName; key: string | null; name: string | null; dimension: string | null; distance: number | null;
  set: boolean; skipped: boolean; skippedBy: string | null; inherit: Inherit | null; rules: number; defaultVariant: string | null; defaultWins?: boolean;
};

/** What the server sends per flag: the evaluator's answer for this entity (server/evaluator.ts forEntity). */
export type EntityFlag = {
  key: string; valueType: string; kind: string; description: string | null; owner: string | null;
  enabled: boolean; delivery: string[]; hasOwn: boolean; ownVersion: number | null;
  levels: Level[];
  variations: { key: string; value: unknown; own: boolean }[];
  answer: EntityAnswer;
  everyone: AnswerPick;
};
/** An entity as the pages name it. */
export type Who = { key: string; name: string; dimension: string; parent?: string | null };
export type EntityView = Paged & { entity: Who; above: Who[]; children: Who[]; environment: string; withOwn: number; rows: EntityFlag[] };

export const kindName = (k: string) => KIND_INFO[k]?.split(' — ')[0] ?? k.replace('_', ' ');
export const typeName = (t: string) => (t === 'bool' ? 'Boolean' : t === 'string' ? 'String' : t === 'number' ? 'Number' : 'JSON');
/** A list's count in the page bar: "12 of 1,009" once a search or filter narrows it. */
export const countText = (d: Paged) => (d.matched === d.all ? d.all.toLocaleString() : `${d.matched.toLocaleString()} of ${d.all.toLocaleString()}`);
/** The main pane scrolls, not the table: after turning a page, start the new one at its top. */
export const toTop = (el: HTMLElement | null) => el?.closest('main')?.scrollTo({ top: 0 });

/** A variant's name in a 1px box, beside its value when the name says something the value doesn't. */
export const tag = 'inline-block shrink-0 border border-rule-2 px-[7px] font-mono text-11 leading-[18px] text-ink-2';
/** A selected row is washed (data-selected: aria-selected doesn't belong in a table). */
export const selectedRow = 'data-[selected=true]:bg-wash';
/** The cell a row opens from: a real button, so keyboard and screen-reader users can open it too. */
export const cellButton = 'block max-w-full cursor-default truncate border-0 bg-transparent p-0 text-left text-ink outline-none decoration-ink-4 underline-offset-4 hover:underline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-ink';
export const MD = 'max-md:hidden';

/** The last value that wasn't null, so a drawer keeps its content while it slides out. It's kept in state and set
 *  while rendering only when the value changes (no effect, and no ref written during render). */
export function useLast<T>(value: T | null): T | null {
  const [last, setLast] = useState(value);
  if (value !== null && value !== last) setLast(value);
  return value ?? last;
}

/** Whether this entity's own settings decided (or a rule for everyone that names it, or one above it). */
export const isMine = (p: AnswerPick, who: EntityWords) =>
  ((p.section === 'entity_rule' || p.section === 'entity_default') && p.owner === who.key) || p.namesEntity;

/** The nearest entity above whose settings this flag follows here (its own settings aside): the first level above it
 *  that has settings and isn't skipped. null: it gets everyone's. */
export function followsFrom(flag: Pick<EntityFlag, 'levels'>, key: string): Level | null {
  return flag.levels.find((l) => l.who === 'entity' && l.key !== key && l.set && !l.skipped) ?? null;
}

/** The entities above one, its parent first, as the console knows them. */
export function aboveOf(meta: Pick<Meta, 'entities'>, key: string): Who[] {
  const byKey = entityIndex(meta.entities);
  const out: Who[] = [];
  for (let p = byKey.get(key)?.parent; p && out.length < 3 && p !== key; p = byKey.get(p)?.parent) {
    const e = byKey.get(p);
    if (!e) break;
    out.push({ key: e.key, name: e.name, dimension: e.dimension, parent: e.parent });
  }
  return out;
}

/** The dimension's words, or a stand-in made from its key for one the console doesn't know (yet). */
export const dimensionOrKey = (dims: readonly Dimension[], key: string): Dimension =>
  dims.find((d) => d.key === key) ?? { key, singular: key, plural: key };

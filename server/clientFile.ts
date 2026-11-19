// The cached client file: what one entity's app gets in one environment, as values (no rules), built once
// per publish and served from a CDN to every device of that entity. The few things only the device
// knows (its model, OS, browser, app version, its own id for a % of devices) stay in the file as small
// "when" lines, and the device picks its line itself (readClientFile: the reference logic for anything that reads the file).
//
// Nothing private is sent: checks on every dimension, the app and the environment are settled on the server
// (evaluator.ts forEntity), so lists of entities and other entities' values never reach a device.

import { bucketFor } from './hash.ts';
import { CODE_DEFAULT, forEntity, sortedFlagKeys, testCondition, type Condition, type EntityInfo, type OutsideMark, type Snapshot } from './evaluator.ts';

/** One line of a flag, tried in order. When every check passes (and, for a split, the device is inside it):
 *  - a value line gives its value;
 *  - an `outside` line (a % rule's name for devices outside it) remembers that name and the walk goes on. */
export type FileLine = {
  if: Condition[];
  value?: unknown;
  codeDefault?: true;                // no remote value: the app keeps the default in its code
  locked?: true;                     // an override: a missing attribute counts as a match
  split?: { by: string; fallbackBy?: string; salt: string; hashVersion: number; from: number; to: number };
  group?: string | null;             // present when a % decides: its part's name (null = no name)
  outside?: string;                  // an outside line: the name devices outside the % carry from here on
  unit?: { by: string; fallbackBy?: string };   // an outside line: the ID the % is by (none = everyone who gets here)
};
/** A flag in the file: its value, or lines tried in order before that value. `group` as on a line. */
export type FileFlag = { value?: unknown; codeDefault?: true; group?: string | null; when?: FileLine[] };
export type ClientFile = { environment: string; revision: number; flags: Record<string, FileFlag> };

export function buildClientFile(snap: Snapshot, project: string, entity: EntityInfo | null, settled: Record<string, unknown> = {}): ClientFile {
  const flags: Record<string, FileFlag> = {};
  const valueOf = (flagKey: string, variant: string): { value?: unknown; codeDefault?: true } =>
    variant === CODE_DEFAULT ? { codeDefault: true } : { value: snap.flags[flagKey].variations[variant] };
  const groupOf = (g: string | null | undefined) => (g === undefined ? {} : { group: g });
  for (const key of sortedFlagKeys(snap)) {
    const flag = snap.flags[key];
    if (!flag.delivery.includes(project)) continue;
    const a = forEntity(flag, snap, entity, { project, ...settled });
    const marks = a.outside ?? [];
    const when: FileLine[] = [];
    const markLine = (m: OutsideMark): FileLine => ({ if: m.when, outside: m.group, ...(m.locked ? { locked: true as const } : {}),
      ...(m.unit ? { unit: { by: m.unit.by, ...(m.unit.fallbackBy ? { fallbackBy: m.unit.fallbackBy } : {}) } } : {}) });
    a.exceptions.forEach((e, i) => {
      for (const m of marks) if (m.at === i) when.push(markLine(m));
      when.push({
        if: e.when,
        ...valueOf(key, e.variant),
        ...(e.locked ? { locked: true as const } : {}),
        ...(e.split ? { split: { by: e.split.by, ...(e.split.fallbackBy ? { fallbackBy: e.split.fallbackBy } : {}), salt: e.split.salt,
          hashVersion: e.split.hashVersion, from: e.split.range.from, to: e.split.range.to } } : {}),
        ...groupOf(e.group),
      });
    });
    for (const m of marks) if (m.at >= a.exceptions.length) when.push(markLine(m));
    const gets = valueOf(key, a.gets.variant);
    // a flag that always uses the in-app default, with no group name to report, is left out: the app keeps its built-in value
    const named = !!a.gets.group || marks.length > 0 || a.exceptions.some((e) => e.group);
    if (gets.codeDefault && !named && when.every((l) => l.codeDefault)) continue;
    flags[key] = { ...gets, ...groupOf(a.gets.group), ...(when.length ? { when } : {}) };
  }
  return { environment: snap.environment, revision: snap.revision, flags };
}

const missing = (v: unknown) => v === undefined || v === null || v === '';

/** What the device does with the file: the value for one flag, given what the device knows about itself.
 *  `group`: the % group name to report in the app's own analytics, if any. */
export function readClientFile(file: ClientFile, key: string, attrs: Record<string, unknown>): { value?: unknown; codeDefault?: boolean; group?: string } {
  const f = Object.hasOwn(file.flags, key) ? file.flags[key] : undefined;   // a key like "constructor" is no flag
  if (!f) return { codeDefault: true };
  let outside: string | undefined;                  // the first outside name this device picked up
  const unitOf = (u: { by: string; fallbackBy?: string }) => {
    const v = attrs[u.by];
    return missing(v) && u.fallbackBy ? attrs[u.fallbackBy] : v;
  };
  const answer = (x: { value?: unknown; codeDefault?: true; group?: string | null }) => {
    const group = 'group' in x ? x.group ?? undefined : outside;   // a % names its own group; anything else keeps the outside name
    return { ...(x.codeDefault ? { codeDefault: true } : { value: x.value }), ...(group ? { group } : {}) };
  };
  for (const line of f.when ?? []) {
    const ok = line.if.every((c) => { const r = testCondition(c, attrs[c.field]); return r === null ? !!line.locked : r; });
    if (!ok) continue;
    if (line.outside !== undefined) {
      if (line.unit && missing(unitOf(line.unit))) continue;        // no ID to split by: the % doesn't apply at all
      outside ??= line.outside;
      continue;
    }
    if (line.split) {
      const unit = unitOf(line.split);
      if (missing(unit)) continue;
      const b = bucketFor(line.split.salt, String(unit), line.split.hashVersion);
      if (b < line.split.from || b >= line.split.to) continue;
    }
    return answer(line);
  }
  return answer(f);
}

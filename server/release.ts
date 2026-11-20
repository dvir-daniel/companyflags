// Releases (docs/design/releases.md). A release is a flag of kind 'release' that turns a new feature on step by step,
// then is removed. Nothing is stored for it beyond the flag: where a release is in one environment is read here from
// the flag's defaults (its base layer), and each step builds the next defaults, which are saved like any other change
// to them (now, or as a request where the environment needs review). One pure module shared with the console, like
// checks.ts and policy.ts: the Releases list (GET /releases), the release page and its timeline read it.
//
//   releaseState(variants, base)        where it is: not started, early access, a % of devices, everyone, or custom
//   ownRules(variants, base)            which rules are the release's own (the rest are left alone)
//   applyChange(variants, base, change) the defaults after a step
//   nextChange(state), backChange(state) the step after or before this one
//   stepText(state), changeText(a, b)   the words
//
// The steps of an on/off release, as its defaults:
//   not started   the default is the old value (false, or the in-app default) and none of the release's rules exist
//   early access  a rule for everyone on `entity` ("Company or brand is one of …") serving the new value (true):
//                 those entities have it on every device, whatever the %
//   % of devices  then a rule serving true to one range [0, N%) of devices: widening moves only its end, so every
//                 device inside stays inside (checks.ts allows it without a reshuffle)
//   everyone      the default is the new value, and the release's rules are gone. Not a 100% rule: a device without
//                 an ID never matches a % rule, but the default reaches it
// Paused: the release's rules are kept with `disabled`, so resuming brings back the same devices. Any other shape
// (two % rules, a % that doesn't start at 0, a default that is neither value, a release that isn't on/off) is custom:
// it's edited on the flag page. The rules are recognised by their shape, not their names.
//
// A version release (docs/design/release-versions.md) has versions for values ("1.0.0", semver.ts isReleaseVersion)
// instead of on and off, and stays: its default is the version an environment is on, and the same two rules serve the
// version that's moving to it. Not started: a higher version exists and nobody has it; everyone: nothing higher. Its %
// is salted with the version, so each version reaches new devices first; rolled back is what paused is for on/off.

import { CODE_DEFAULT } from './evaluator.ts';
import { compareVersions, isReleaseVersion } from './semver.ts';

type Cond = { field: string; op: string; values?: (string | number)[] };
type Range = { variation: string; from: number; to: number; group?: string };
type SplitLike = { by: string; fallbackBy: string | null; salt?: string; hashVersion?: number; ranges: Range[]; outsideGroup?: string };
/** A rule as the server keeps it (evaluator.ts Rule) or the console has it (api.ts Rule). */
export type RuleLike = { ruleKey?: string; name: string | null; locked: boolean; disabled: boolean; conditions: Cond[]; serveVariation: string | null; split: SplitLike | null };
/** The flag's defaults in one environment: its base layer. */
export type LayerLike = { enabled: boolean | null; defaultVariation: string | null; rules: RuleLike[] };
export type Variant = { key: string; value: unknown };

export type Step = 'not_started' | 'early' | 'percent' | 'everyone' | 'custom';
export type ReleaseState = {
  step: Step;
  /** the flag's switch here: off sends nothing, and apps use their code default */
  on: boolean;
  /** at the % step: the % of devices (0–100) */
  percent: number | null;
  /** the % is limited to these apps ("App is one of …"); null: every app */
  apps: string[] | null;
  /** early access: these entities get it on every device, whatever the % */
  entities: string[];
  /** the release's rules are switched off (kept, so resuming brings back the same devices) */
  paused: boolean;
  /** the variant keys of the new and the old value; null when the flag isn't an on/off release */
  newValue: string | null;
  oldValue: string | null;
  /** rules that aren't the release's own (overrides included): they stay as they are */
  others: number;
  /** a version release: its versions; null for an on/off release */
  versions: Versions | null;
};
export type Versions = {
  /** the version everyone outside the release's rules gets (the default); null: the version built into the app */
  current: string | null;
  /** the version that's moving (the release's rules serve it), or, while none is, the newest above `current`: ready to
   *  start. null: there's nothing higher */
  target: string | null;
  /** every version, lowest first */
  all: string[];
};

/** The % steps; any whole % between them works too. After the last comes everyone. */
export const LADDER = [1, 5, 25, 50] as const;

const EARLY_NAME = 'Early access';
const rolloutName = (percent: number, old?: string | null) => {
  const fresh = `${percent}% of devices`;
  if (!old) return fresh;
  // "20% of android devices" → "25% of android devices"; a name of someone's own is kept
  return /^\d+(\.\d+)?%/.test(old) ? old.replace(/^\d+(\.\d+)?%/, `${percent}%`) : old;
};

const valuesOf = (variants: readonly Variant[]) => ({
  newValue: variants.find((v) => v.value === true)?.key ?? null,
  oldValue: variants.find((v) => v.value === false)?.key ?? null,
});

/** The values a release can serve: its variants without the in-app default. A version release's are free values (hidden,
 *  content-addressed variants, evaluator.ts hiddenKey): it lists no variants, and each version is the value it is. */
const listed = (variants: readonly Variant[]) => variants.filter((v) => v.key !== CODE_DEFAULT);

/** A version release: every value it lists is a release version (semver.ts). */
export const isVersionRelease = (variants: readonly Variant[]) => {
  const vs = listed(variants);
  return vs.length > 0 && vs.every((v) => isReleaseVersion(v.value));
};

/** A version release's versions in one environment, and the keys of the version it's on and the one moving to it. */
function versionsOf(variants: readonly Variant[], base: LayerLike) {
  const byKey = new Map(listed(variants).map((v) => [v.key, v.value as string]));
  const all = [...byKey.values()].sort(compareVersions);
  const def = base.defaultVariation;
  const current = def && byKey.has(def) ? byKey.get(def)! : null;
  // the default is a version, or the in-app default; anything else (a value typed for everyone) doesn't follow the steps
  const ok = def === CODE_DEFAULT || current !== null;
  const above = (key: string | null | undefined): key is string => !!key && byKey.has(key) && (current === null || compareVersions(byKey.get(key)!, current) > 0);
  // the version moving: the one the first rule of the release's shapes serves (switched off too: rolled back keeps it)
  const moving = base.rules.map((r) => (r.split ? r.split.ranges[0]?.variation : r.serveVariation))
    .find((k, i) => above(k) && (isEarly(base.rules[i], k!) || isRollout(base.rules[i], k!)));
  const newest = [...byKey].filter(([k]) => above(k)).sort((a, b) => compareVersions(a[1], b[1])).at(-1)?.[0];
  const targetKey = moving ?? newest ?? null;
  return { ok, all, current, currentKey: def, targetKey, target: targetKey ? byKey.get(targetKey)! : null, above, byKey };
}

const isEarly = (r: RuleLike, newValue: string) => !r.locked && !r.split && r.serveVariation === newValue
  && r.conditions.length === 1 && r.conditions[0].field === 'entity' && r.conditions[0].op === 'in';
const isRollout = (r: RuleLike, newValue: string) => !r.locked && !!r.split && r.split.ranges.length === 1
  && r.split.ranges[0].from === 0 && r.split.ranges[0].variation === newValue
  && r.conditions.length <= 1 && r.conditions.every((c) => c.field === 'project' && c.op === 'in');

/** Where the release's own rules are: the first early-access rule and the first % rule (-1: none). */
function findRules(base: LayerLike, newValue: string) {
  return { early: base.rules.findIndex((r) => isEarly(r, newValue)), rollout: base.rules.findIndex((r) => isRollout(r, newValue)) };
}

/** The positions of the release's own rules in its defaults (early access, the %); every other rule is left alone. */
export function ownRules(variants: readonly Variant[], base: LayerLike): number[] {
  const { newValue, oldValue } = valuesOf(variants);
  if (!newValue || !oldValue) return [];
  const { early, rollout } = findRules(base, newValue);
  return [early, rollout].filter((i) => i >= 0);
}

/** Where a release is in one environment, read from its defaults there. */
export function releaseState(variants: readonly Variant[], base: LayerLike): ReleaseState {
  const ver = isVersionRelease(variants) ? versionsOf(variants, base) : null;
  const { newValue, oldValue } = ver ? { newValue: ver.targetKey, oldValue: ver.currentKey } : valuesOf(variants);
  const on = !!base.enabled;
  const versions: Versions | null = ver && { current: ver.current, target: ver.target, all: ver.all };
  const custom: ReleaseState = { step: 'custom', on, percent: null, apps: null, entities: [], paused: false, newValue, oldValue, others: base.rules.length, versions };
  if (ver && !ver.ok) return custom;
  // a version release with nothing higher than the version it's on: everyone has that one
  if (ver && !newValue) return { ...custom, step: 'everyone' };
  if (!newValue || !oldValue) return custom;
  const { early, rollout } = findRules(base, newValue);
  const earlyRule = early >= 0 ? base.rules[early] : null;
  const rolloutRule = rollout >= 0 ? base.rules[rollout] : null;
  const def = base.defaultVariation;
  const others = base.rules.length - (earlyRule ? 1 : 0) - (rolloutRule ? 1 : 0);
  const state: ReleaseState = {
    ...custom, others,
    entities: earlyRule ? (earlyRule.conditions[0].values ?? []).map(String) : [],
    percent: rolloutRule ? rolloutRule.split!.ranges[0].to / 100 : null,
    apps: rolloutRule?.conditions.length ? (rolloutRule.conditions[0].values ?? []).map(String) : null,
    paused: [earlyRule, rolloutRule].some((r) => r?.disabled),
  };
  if (!ver && def === newValue) return { ...state, step: 'everyone', percent: null, apps: null, entities: [], paused: false };
  if (def !== oldValue && def !== CODE_DEFAULT) return custom;
  // another rule that hands out the new value (a second %, a % that doesn't start at 0, "App version 6+ → on"): the
  // steps wouldn't say who has it. For a version release, any version higher than the default: two would be moving
  const servesNew = (r: RuleLike) => [r.serveVariation, ...(r.split?.ranges ?? []).map((g) => g.variation)]
    .some((k) => (ver ? ver.above(k) : k === newValue));
  if (base.rules.some((r, i) => i !== early && i !== rollout && !r.disabled && servesNew(r))) return custom;
  if (rolloutRule) return { ...state, step: 'percent' };
  if (earlyRule) return { ...state, step: 'early' };
  return { ...state, step: 'not_started' };
}

/** A step. `percent` 0 removes the %; `entities` [] ends the early access. A version release also takes:
 *  `everyone` with a version (everyone on it now: releasing a version in one step, or rolling back to an older one),
 *  `replace` (the version moving is another, higher one, on the same devices) and `resume` with a version (both). */
export type Change =
  | { kind: 'percent'; percent: number }
  | { kind: 'everyone'; version?: string }
  | { kind: 'entities'; entities: string[] }
  | { kind: 'pause' }
  | { kind: 'resume'; version?: string }
  | { kind: 'replace'; version: string };

const newKey = () => globalThis.crypto.randomUUID();
const CUSTOM = 'this release’s rules don’t follow the steps: edit them on the flag page';

/**
 * The defaults after a step, with everything that isn't the release's own left where it is (overrides, other rules,
 * the order). A step that starts a release that hasn't started turns the flag on (a new flag starts off where the
 * environment needs review); a release turned off mid-way stays off until someone turns it on. Throws on a release
 * that is custom: those are edited on the flag page. `flagKey`: needed for the % of a version release, whose salt is
 * `<flag key>/<version>` (an on/off release's is the flag key, which checks.ts fills in).
 */
export function applyChange<L extends LayerLike>(variants: readonly Variant[], base: L, change: Change, flagKey?: string): L {
  const state = releaseState(variants, base);
  const ver = state.versions;
  if (state.step === 'custom' || (!ver && (!state.newValue || !state.oldValue))) throw new Error(CUSTOM);
  // a version of this release, by its key
  const keyOf = (version: string) => {
    if (!ver) throw new Error('only a version release has versions');
    const key = listed(variants).find((v) => v.value === version)?.key;
    if (!key) throw new Error(`${version} isn’t one of this release’s versions`);
    return key;
  };
  const higher = (version: string) => {
    if (ver?.current && compareVersions(version, ver.current) <= 0) throw new Error(`${version} isn’t higher than ${ver.current}, the version everyone else is on`);
    return keyOf(version);
  };
  if (!state.newValue && !(change.kind === 'everyone' && change.version)) throw new Error(`there’s no version higher than ${ver?.current ?? 'this one'}: add one first`);
  const newValue = state.newValue;
  const enabled = !!base.enabled || state.step === 'not_started';
  let rules = [...base.rules];
  let defaultVariation = base.defaultVariation;
  let serving = newValue;                                   // the version the release's rules serve (replace changes it)
  const at = () => (serving ? findRules({ ...base, rules }, serving) : { early: -1, rollout: -1 });
  const without = (i: number) => { if (i >= 0) rules = rules.filter((_, j) => j !== i); };
  /** the release's own rules serve this version instead (only a range's value changes, so its devices stay: checks.ts) */
  const serve = (key: string) => {
    const { early, rollout } = at();
    if (early >= 0) rules[early] = { ...rules[early], serveVariation: key };
    if (rollout >= 0) { const r = rules[rollout]; rules[rollout] = { ...r, split: { ...r.split!, ranges: [{ ...r.split!.ranges[0], variation: key }] } }; }
    serving = key;
  };
  const moving = state.step === 'early' || state.step === 'percent';

  switch (change.kind) {
    case 'percent': {
      const p = change.percent;
      if (!Number.isInteger(p * 100) || p < 0 || p >= 100) throw new Error('a % of devices is between 0 and 100 (use everyone for 100%)');
      if (defaultVariation === newValue) defaultVariation = state.oldValue;      // back from everyone
      const { rollout } = at();
      if (p === 0) { without(rollout); break; }
      if (rollout >= 0) {
        const r = rules[rollout];
        // only the range's end moves: every device inside stays inside when it grows
        rules[rollout] = { ...r, name: rolloutName(p, r.name), split: { ...r.split!, ranges: [{ ...r.split!.ranges[0], to: Math.round(p * 100) }] } };
      } else {
        // an on/off release: the salt is the flag key (checks.ts), so a % made again puts the same devices inside as
        // before. A version release: the salt names the version, so each version reaches new devices first
        if (ver && !flagKey) throw new Error('a version release’s % needs the flag key');
        rules.push({ ruleKey: newKey(), name: rolloutName(p), locked: false, disabled: false, conditions: [], serveVariation: null,
          split: { by: 'device.id', fallbackBy: null, ...(ver ? { salt: `${flagKey}/${ver.target}` } : {}), ranges: [{ variation: newValue!, from: 0, to: Math.round(p * 100) }] } });
      }
      break;
    }
    case 'everyone': {
      const { early, rollout } = at();
      defaultVariation = change.version ? keyOf(change.version) : newValue;
      if (ver && defaultVariation === base.defaultVariation && early < 0 && rollout < 0) throw new Error(`everyone is on ${change.version} already`);
      rules = rules.filter((_, j) => j !== early && j !== rollout);
      break;
    }
    case 'entities': {
      const entities = [...new Set(change.entities.map((c) => c.trim()).filter(Boolean))];
      const { early, rollout } = at();
      if (!entities.length) { without(early); break; }
      if (state.step === 'everyone') throw new Error('everyone has it already');
      const condition = { field: 'entity', op: 'in', values: entities };
      if (early >= 0) rules[early] = { ...rules[early], conditions: [condition] };
      else {
        const rule: RuleLike = { ruleKey: newKey(), name: EARLY_NAME, locked: false, disabled: false, conditions: [condition], serveVariation: newValue, split: null };
        // before the %: early access has it on every device
        rules.splice(rollout >= 0 ? rollout : rules.length, 0, rule);
      }
      break;
    }
    case 'replace': {
      if (!moving) throw new Error('nothing is moving to a version yet: start one instead');
      const key = higher(change.version);
      if (key === newValue) throw new Error(`${change.version} is already the version moving`);
      serve(key);
      break;
    }
    case 'pause': case 'resume': {
      if (change.kind === 'resume' && change.version) {
        if (!moving || !state.paused) throw new Error('only a rolled-back version can be resumed with another one');
        const key = higher(change.version);
        if (key !== newValue) serve(key);
      }
      const { early, rollout } = at();
      for (const i of [early, rollout]) if (i >= 0) rules[i] = { ...rules[i], disabled: change.kind === 'pause' };
      break;
    }
  }
  return { ...base, enabled, defaultVariation, rules } as L;
}

/** The next step: the next % of the ladder, then everyone. Null when there is none here (custom, everyone, paused). */
export function nextChange(s: ReleaseState): Change | null {
  if (s.step === 'custom' || s.step === 'everyone' || s.paused) return null;
  if (s.step === 'percent') {
    const next = LADDER.find((p) => p > s.percent!);
    return next ? { kind: 'percent', percent: next } : { kind: 'everyone' };
  }
  return { kind: 'percent', percent: LADDER[0] };
}

/** One step back: from everyone to 50%, from a % to the one below it, from the first % to none. Early access is
 *  changed by editing who has it. A version release has no way back from everyone to 50% (the version before isn't
 *  in its defaults): it rolls back to that version with `everyone`. */
export function backChange(s: ReleaseState): Change | null {
  if (s.paused) return null;
  if (s.step === 'everyone') return s.versions ? null : { kind: 'percent', percent: LADDER[LADDER.length - 1] };
  if (s.step !== 'percent') return null;
  const below = [...LADDER].reverse().find((p) => p < s.percent!);
  return { kind: 'percent', percent: below ?? 0 };
}

/** The version everyone else is on, in words. */
const onNow = (v: Versions) => v.current ?? 'the built-in version';
const share = (s: ReleaseState) => (s.step === 'early' ? `${s.entities.length} in early access` : `${s.percent}% of devices${s.apps ? ` on ${s.apps.join(', ')}` : ''}`);

/** The step in words: "25% of devices on android", "3 in early access", "Paused · 5% of devices"; for a version
 *  release "1.0.0 → 1.0.1 · 25% of devices", "Everyone on 1.0.1", "1.0.1 · 1.0.2 ready". */
export function stepText(s: ReleaseState): string {
  if (s.versions) {
    const v = s.versions;
    const words = s.step === 'custom' ? 'Custom'
      : s.step === 'everyone' ? `Everyone on ${onNow(v)}`
      : s.step === 'not_started' ? `${v.current ?? 'Built-in version'} · ${v.target} ready`
      : s.paused ? `Rolled back to ${onNow(v)} · ${v.target} paused at ${share(s)}`
      : `${v.current ?? 'Built-in'} → ${v.target} · ${share(s)}`;
    // off sends nothing: apps use the version built into them, whatever the step
    return s.on ? words : `Off · ${words}`;
  }
  const words = s.step === 'custom' ? 'Custom'
    : s.step === 'not_started' ? 'Not started'
    : s.step === 'everyone' ? 'Everyone'
    : share(s);
  if (!s.on && s.step !== 'not_started') return `Off · ${words}`;
  return s.paused ? `Paused · ${words}` : words;
}

/** What one change did, in words ("5% → 25% of devices", "Paused"); null when the release didn't move. */
export function changeText(a: ReleaseState | null, b: ReleaseState): string | null {
  if (!a) return `Created · ${stepText(b)}`;
  // a release's first step turns its flag on (a new flag starts off where changes are reviewed): say the step
  if (!a.on && b.on) { const step = changeText({ ...a, on: true }, b); return step ? `${step}, and turned on` : 'Turned on'; }
  if (a.on !== b.on) return b.on ? 'Turned on' : 'Turned off';
  if (a.versions && b.versions) return versionChangeText(a, a.versions, b, b.versions);
  if (a.paused !== b.paused) return b.paused ? 'Paused' : 'Resumed';
  const early = earlyText(a, b);
  const from = stepText(a);
  const to = stepText(b);
  if (from !== to && !(a.step === 'early' && b.step === 'early')) {
    return a.step === 'percent' && b.step === 'percent' && a.apps?.join() === b.apps?.join()
      ? `${a.percent}% → ${b.percent}% of devices` : `${from} → ${to}`;
  }
  if (early) return `Early access: ${early}`;
  return null;
}

function earlyText(a: ReleaseState, b: ReleaseState) {
  const added = b.entities.filter((c) => !a.entities.includes(c));
  const removed = a.entities.filter((c) => !b.entities.includes(c));
  return [...added.map((c) => `+ ${c}`), ...removed.map((c) => `− ${c}`)].join(', ');
}

/** A version release's change: "Started 1.0.1 at 1% of devices", "1.0.1: 5% → 25% of devices", "Released 1.0.1 to
 *  everyone", "Rolled back to 1.0.0", "Replaced 1.0.1 with 1.0.2", "Resumed 1.0.2 at 25% of devices". */
function versionChangeText(a: ReleaseState, av: Versions, b: ReleaseState, bv: Versions): string | null {
  const moving = (s: ReleaseState) => s.step === 'early' || s.step === 'percent';
  if (av.current !== bv.current) {
    const back = av.current && bv.current && compareVersions(bv.current, av.current) < 0;
    return back ? `Rolled back to ${bv.current}` : bv.current ? `Released ${bv.current} to everyone` : 'Everyone on the built-in version';
  }
  if (a.paused !== b.paused) {
    if (b.paused) return `Rolled back to ${onNow(bv)} (${av.target} paused at ${share(a)})`;
    return av.target !== bv.target ? `Resumed with ${bv.target} at ${share(b)}` : `Resumed ${bv.target} at ${share(b)}`;
  }
  if (moving(a) && moving(b) && av.target !== bv.target) return `Replaced ${av.target} with ${bv.target}`;
  if (!moving(a) && moving(b)) return `Started ${bv.target} at ${share(b)}`;
  if (moving(a) && !moving(b)) return `${av.target}: back to not started`;
  if (a.step === 'percent' && b.step === 'percent' && a.percent !== b.percent) return `${bv.target}: ${a.percent}% → ${b.percent}% of devices`;
  const early = earlyText(a, b);
  if (early) return `${bv.target}: early access ${early}`;
  if (a.step === 'early' && b.step === 'percent') return `${bv.target}: started at ${share(b)}`;
  const from = stepText(a);
  const to = stepText(b);
  return from === to ? null : `${from} → ${to}`;
}

/** Whether a step of a version release is a rollback: every device goes back to a version it had before, which those who
 *  may break glass can do without review (policy.ts canBreakGlassRollback). Mid-way, everyone back on the version
 *  everyone else is on (the % kept); otherwise everyone on an older version this environment served while it was on
 *  (`served`: GET /flags/:key `versions[env].served`). layers.ts checks the saved layer the same way. */
export function isRollback(s: ReleaseState, change: Change, served: readonly string[]): boolean {
  if (!s.versions || !s.on || s.step === 'custom') return false;
  if (change.kind === 'pause') return (s.step === 'early' || s.step === 'percent') && !s.paused;
  return change.kind === 'everyone' && !!change.version && !!s.versions.current && served.includes(change.version)
    && compareVersions(change.version, s.versions.current) < 0;
}

/** Rules that keep older app builds on an older version ("App version is below 5.2.0 → 1.0.0"), in words: they aren't
 *  the release's own, so every step leaves them where they are. */
export function holdBacks(variants: readonly Variant[], base: LayerLike): string[] {
  if (!isVersionRelease(variants)) return [];
  const byKey = new Map(listed(variants).map((v) => [v.key, String(v.value)]));
  return base.rules.filter((r) => !r.disabled && !r.split && r.serveVariation && byKey.has(r.serveVariation) && r.conditions.length === 1
    && r.conditions[0].field === 'app.version' && (r.conditions[0].op === 'semver_lt' || r.conditions[0].op === 'semver_lte'))
    .map((r) => `Apps ${r.conditions[0].op === 'semver_lt' ? 'below' : 'at or below'} ${r.conditions[0].values?.[0]} stay on ${byKey.get(r.serveVariation!)}`);
}

/** Done rolling out: everyone has it in every environment it is sent to, and it is sent somewhere. A version release
 *  stays: it's never cleaned up. */
export const readyToCleanUp = (envs: readonly { state: ReleaseState; sent: boolean }[]) =>
  !envs.some((e) => e.state.versions) && envs.some((e) => e.sent) && envs.every((e) => !e.sent || (e.state.step === 'everyone' && e.state.on));

/** Past its remove-by date (YYYY-MM-DD), on `today` (YYYY-MM-DD). */
export const overdue = (removeBy: string | null | undefined, today: string) => !!removeBy && removeBy < today;

// Typed version comparison. "5.10" > "5.9", "5" == "5.0.0", prereleases sort before releases.

export type SemVer = { major: number; minor: number; patch: number; pre: string[] };

export function parseSemver(raw: unknown): SemVer | null {
  if (typeof raw !== 'string') return null;
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(raw.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: m[2] ? Number(m[2]) : 0,
    patch: m[3] ? Number(m[3]) : 0,
    pre: m[4] ? m[4].split('.') : [],
  };
}

/** A version as three numbers, as strict semver readers (flagd's sem_ver in some languages) need it: "6" → "6.0.0",
 *  "v6.1" → "6.1.0", "6.0-beta.1" → "6.0.0-beta.1". The build part goes: comparing ignores it. Null when it isn't
 *  a version. */
export function fullVersion(raw: unknown): string | null {
  const v = parseSemver(raw);
  return v ? `${v.major}.${v.minor}.${v.patch}${v.pre.length ? `-${v.pre.join('.')}` : ''}` : null;
}

export function compareSemver(a: SemVer, b: SemVer): number {
  for (const k of ['major', 'minor', 'patch'] as const) {
    if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  }
  if (!a.pre.length && !b.pre.length) return 0;
  if (!a.pre.length) return 1;
  if (!b.pre.length) return -1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

// ---- release versions (docs/content/docs/guide/releases.md) ------------------------------------------------------------
// A version release's values: SemVer 2.0.0, a little stricter, so each version has one spelling. Three whole numbers
// without leading zeros, an optional lowercase prerelease; no "v" (semver.org: "v1.2.3" is not a semantic version) and
// no "+build" (semver ignores it when comparing, so 1.0.1+5 and 1.0.1+6 would be the same version). Rules stay
// lenient (parseSemver): they compare what devices report.

const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-z-][0-9a-z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-z-][0-9a-z-]*))*))?$/;
export const RELEASE_VERSION_MAX = 64;

/** What's wrong with a release version, in words; null when it is one. */
export function releaseVersionProblem(v: unknown): string | null {
  if (typeof v !== 'string' || v === '') return 'Write a version, like 1.0.0';
  if (v !== v.trim()) return 'No spaces around the version';
  if (v.length > RELEASE_VERSION_MAX) return `At most ${RELEASE_VERSION_MAX} characters`;
  if (/^v/i.test(v)) return releaseVersionProblem(v.slice(1)) ? 'No v in front: three numbers, like 1.0.0' : `Write it as ${v.slice(1)}: no v in front`;
  if (v.includes('+')) return `No + part: semver ignores it when comparing versions (${v.slice(0, v.indexOf('+'))})`;
  if (RELEASE_VERSION.test(v)) {
    const numbers = v.split(/[.-]/).filter((p) => /^\d+$/.test(p));
    return numbers.every((n) => Number(n) <= Number.MAX_SAFE_INTEGER) ? null : 'Each number is at most 9007199254740991';
  }
  if (RELEASE_VERSION.test(v.toLowerCase())) return `Lowercase after the dash: ${v.toLowerCase()}`;
  if (/^\d+(\.\d+)?$/.test(v)) return 'Three numbers, like 1.0.0';
  if (/(^|\.)0\d/.test(v.split('-')[0])) return 'No leading zeros, like 1.0.1 (not 01.0.1)';
  return 'Write it as 1.0.1: three numbers, then an optional -beta.1';
}
export const isReleaseVersion = (v: unknown): v is string => releaseVersionProblem(v) === null;

/** Two release versions in semver order (negative: a is lower). */
export const compareVersions = (a: string, b: string) => compareSemver(parseSemver(a)!, parseSemver(b)!);

/** The next version, as `npm version` makes it: a prerelease goes to its release (1.1.0-rc.1 → patch 1.1.0). */
export function bumpVersion(v: string, part: 'patch' | 'minor' | 'major'): string {
  const s = parseSemver(v)!;
  const pre = s.pre.length > 0;
  if (part === 'patch') return pre ? `${s.major}.${s.minor}.${s.patch}` : `${s.major}.${s.minor}.${s.patch + 1}`;
  if (part === 'minor') return pre && s.patch === 0 ? `${s.major}.${s.minor}.0` : `${s.major}.${s.minor + 1}.0`;
  return pre && s.minor === 0 && s.patch === 0 ? `${s.major}.0.0` : `${s.major + 1}.0.0`;
}

/** What's wrong with adding this version to a release that has these: a release version, higher than every one. */
export function newVersionProblem(v: unknown, existing: readonly string[]): string | null {
  const problem = releaseVersionProblem(v);
  if (problem) return problem;
  if (existing.includes(v as string)) return `${v} is already a version`;
  const newest = [...existing].sort(compareVersions).at(-1);
  return newest && compareVersions(v as string, newest) <= 0 ? `Higher than ${newest}, the newest version` : null;
}

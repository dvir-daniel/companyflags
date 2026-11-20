// Helpers for the safety parts of the console: times of scheduled requests with their time zone, how many devices a
// change to a % moves, and the open requests of one flag (the flag page's notice, flagNotices.tsx).

import type { Rule } from '../api.ts';

/** This browser's time zone, as people read it: "Europe/Berlin (UTC+1)". */
export function localZone(at = new Date()): string {
  const name = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
  const offset = -at.getTimezoneOffset();
  const h = Math.trunc(Math.abs(offset) / 60);
  const m = Math.abs(offset) % 60;
  return `${name} (UTC${offset < 0 ? '−' : '+'}${h}${m ? `:${String(m).padStart(2, '0')}` : ''})`;
}

/** A time with its zone, for "Scheduled for …": "21 Nov 2026, 09:00 CET". The UTC time is `utcText`. */
export const zonedText = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZoneName: 'short' });
export const utcText = (iso: string) => `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/** How far off a time is, in words: "in 14 hours", "in 5 minutes". */
export function fromNow(iso: string, now = Date.now()): string {
  const min = Math.round((new Date(iso).getTime() - now) / 60000);
  if (min < 1) return 'in less than a minute';
  if (min < 90) return `in ${min} minute${min === 1 ? '' : 's'}`;
  const h = Math.round(min / 60);
  if (h < 48) return `in ${h} hours`;
  return `in ${Math.round(h / 24)} days`;
}

/** A datetime-local value (local time, to the minute) for a time. */
export const localInput = (at: Date) => new Date(at.getTime() - at.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

/** Why this datetime-local value can't be a schedule time; null when it can. */
export function scheduleProblem(value: string, now = Date.now()): string | null {
  const at = new Date(value);
  if (!value || Number.isNaN(at.getTime())) return 'Pick a date and a time.';
  if (at.getTime() <= now) return 'That time has passed. Pick a time in the future, or apply it now.';
  return null;
}

/**
 * How many % points of devices land in another group when a rule's % changes from `before` to `after` (devices are
 * placed in 10000 buckets, so 100 buckets are 1 point). Another salt, ID or hash version puts every device in a new
 * bucket: then all 100 points are reassigned. `lose`: points of devices that were inside a group and are now outside
 * every group or in another one (they lose what they had). Null when neither is a % rule.
 */
export function percentMoves(before: Rule | null | undefined, after: Rule | null | undefined): { moved: number; lose: number; reshuffled: boolean } | null {
  const a = before?.split ?? null;
  const b = after?.split ?? null;
  if (!a && !b) return null;
  if (a && b && (a.salt !== b.salt || a.by !== b.by || (a.hashVersion ?? null) !== (b.hashVersion ?? null))) {
    const inside = a.ranges.reduce((n, r) => n + (r.to - r.from), 0);
    return { moved: 100, lose: inside / 100, reshuffled: true };
  }
  const groupAt = (s: typeof a, bucket: number) => s?.ranges.find((r) => bucket >= r.from && bucket < r.to)?.variation ?? null;
  let moved = 0;
  let lose = 0;
  // the edges of every range cut 0..10000 into spans that each stay in one group before and after
  const cuts = [...new Set([0, 10000, ...[a, b].flatMap((s) => s?.ranges.flatMap((r) => [r.from, r.to]) ?? [])])].sort((x, y) => x - y);
  for (let i = 0; i < cuts.length - 1; i++) {
    const was = groupAt(a, cuts[i]);
    const now = groupAt(b, cuts[i]);
    if (was === now) continue;
    moved += cuts[i + 1] - cuts[i];
    if (was !== null) lose += cuts[i + 1] - cuts[i];
  }
  return { moved: moved / 100, lose: lose / 100, reshuffled: false };
}

/** A request as the list of one flag's requests has it (GET /change-sets?flag=). */
export type FlagRequest = { id: number; environment: string; status: string; author: string; scheduledAt: string | null };
/** Still waiting to go out: in review, approved or scheduled. */
export const isWaiting = (r: { status: string }) => r.status === 'in_review' || r.status === 'approved' || r.status === 'scheduled';

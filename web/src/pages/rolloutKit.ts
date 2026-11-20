// The % box of a rollout rule (CondEditor in FlagPage.tsx). A split's ranges are in hundredths of a percent
// (0 to 10000, server/checks.ts), so a share has at most two decimals.

/** What's typed in the % box: a share to save (in hundredths of a percent), nothing (an empty box), or why not. */
export type PercentRead = { ok: true; to: number } | { ok: true; to: null } | { ok: false; error: string };

/** Reads the % box: a number from 0 to 100 with at most two decimals ("12.5", "12,5", ".5"). Empty saves nothing. */
export function readPercent(text: string): PercentRead {
  const t = text.trim().replace(/%$/, '').trim().replace(',', '.');
  if (!t) return { ok: true, to: null };
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(t)) return { ok: false, error: 'Enter a number from 0 to 100' };
  if (/\.\d{3,}$/.test(t)) return { ok: false, error: 'Use at most two decimals' };
  const p = Number(t);
  if (!Number.isFinite(p) || p < 0 || p > 100) return { ok: false, error: 'Enter a number from 0 to 100' };
  return { ok: true, to: Math.round(p * 100) };
}

/** A share (in hundredths of a percent) as the % box shows it: 1250 → "12.5". */
export const percentText = (to: number) => String(+(to / 100).toFixed(2));

// ---- a split across several values ---------------------------------------------------------------
// The split editor shows a split as parts laid end to end from 0: each part a variant and its share. Devices in no part
// don't match the rule, and the next row decides for them. A split made elsewhere may have gaps between its parts; the
// editor shows it as it is until someone chooses to lay its parts end to end (that moves devices).

export type SplitRange = { variation: string; from: number; to: number; group?: string };
/** Every bucket: 100% in hundredths of a percent. */
export const ALL = 10000;

/** Its parts lie end to end from 0, so each can be given a share. */
export const isContiguous = (ranges: readonly SplitRange[]) => ranges.every((r, i) => r.from === (i === 0 ? 0 : ranges[i - 1].to));
/** How much is in no part (hundredths of a percent). */
export const leftOver = (ranges: readonly SplitRange[]) => ALL - ranges.reduce((n, r) => n + (r.to - r.from), 0);
/** The same parts laid end to end from 0, each keeping its share, variant and group name. */
export const endToEnd = (ranges: readonly SplitRange[]): SplitRange[] => {
  let at = 0;
  return ranges.map((r) => { const share = r.to - r.from; const next = { ...r, from: at, to: at + share }; at += share; return next; });
};
/** One part's share changed: it's kept within what the other parts leave, and the parts after it move along. */
export function withShare(ranges: readonly SplitRange[], i: number, share: number): SplitRange[] {
  const others = ranges.reduce((n, r, j) => (j === i ? n : n + (r.to - r.from)), 0);
  const clamped = Math.max(0, Math.min(share, ALL - others));
  return endToEnd(ranges.map((r, j) => (j === i ? { ...r, to: r.from + clamped } : r)));
}
/** A new part at the end, of the variant given, with up to `share` of what's left. */
export function withPart(ranges: readonly SplitRange[], variation: string, share: number): SplitRange[] {
  const start = endToEnd(ranges);
  const at = start.length ? start[start.length - 1].to : 0;
  return [...start, { variation, from: at, to: at + Math.max(0, Math.min(share, ALL - at)) }];
}
/** Without part `i`; the parts after it move along. */
export const withoutPart = (ranges: readonly SplitRange[], i: number): SplitRange[] => endToEnd(ranges.filter((_, j) => j !== i));

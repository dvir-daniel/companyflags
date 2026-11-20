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

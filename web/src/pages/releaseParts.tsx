// Pieces the Releases list and a release's page share: what GET /releases sends, and a release's step drawn small.
import { cn } from '@companyfeatures/ui/lib/utils';
import type { ReleaseState } from '../../../server/release.ts';
import type { Paged } from '../uiKit.ts';

/** One environment of a release, as GET /releases sends it (server/api.ts). */
export type ReleaseEnv = ReleaseState & { text: string; sent: boolean; changedAt: string | null; waiting: { id: number; status: string } | null };
export type ReleaseRow = {
  key: string; name: string | null; tags: string[]; description: string | null; owner: string | null; removeBy: string | null; createdAt: string;
  envs: Record<string, ReleaseEnv | null>; overdue: boolean; ready: boolean;
};
export type ReleaseList = Paged & { rows: ReleaseRow[]; environments: string[]; owners: string[] };

/** How far a release has gone, 0–100: early access alone shows as a sliver, everyone as full. */
const shareOf = (s: ReleaseState) => (s.step === 'everyone' ? 100 : s.step === 'percent' ? s.percent ?? 0 : s.step === 'early' ? 2 : 0);

/** A release's step as a thin bar: filled to the share that has it; paused in amber, off or custom outlined only. */
export function StepBar({ state, className }: { state: ReleaseState; className?: string }) {
  const share = shareOf(state);
  const idle = !state.on || state.step === 'custom';
  return (
    <span aria-hidden className={cn('relative block h-1.5 w-full overflow-hidden border border-rule bg-panel', state.step === 'custom' && 'border-dashed', className)}>
      {!idle && share > 0 && <span className={cn('absolute inset-y-0 left-0', state.paused ? 'bg-flag' : 'bg-ok')} style={{ width: `${Math.max(share, 2)}%` }} />}
    </span>
  );
}

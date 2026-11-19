// The environments as set in Settings, for any page (the flag editor, releases, history, keys…). Apart from flagParts.tsx
// so that an edit to its components swaps in place in `pnpm dev` (React Fast Refresh); an edit here reloads the page.
import { useMemo } from 'react';
import { useApp } from '../app.ts';
import { needsReview, type EnvFacts } from '../../../server/policy.ts';

export type EnvLookup = {
  envName: (e: string) => string;
  /** An environment as set in Settings, for what policy.ts answers about it (needsReview, approvalsNeeded, switchPath). */
  envOf: (e: string | null | undefined) => EnvFacts | undefined;
  /** A protected environment (policy.ts needsReview): changes there are confirmed before they go out, and it's marked in red. */
  isProtected: (e: string | null | undefined) => boolean;
};
/** The environments as set in Settings, from the app's meta: a page re-renders when they change. */
export function useEnvs(): EnvLookup {
  const { meta } = useApp();
  return useMemo(() => {
    const byKey = new Map(meta.environments.map((e) => [e.key, e]));
    const envOf = (e: string | null | undefined) => (e ? byKey.get(e) : undefined);
    return {
      envName: (e: string) => byKey.get(e)?.name || e,
      envOf,
      isProtected: (e: string | null | undefined) => needsReview(envOf(e)),
    };
  }, [meta.environments]);
}

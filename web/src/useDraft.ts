// The draft session (draftSession.ts) for React: the session of the person signed in, the draft as people read it,
// and one opened flag. Everything about drafts is decided in the session; this file only subscribes and opens.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { api, peek, type FlagDetail } from './api.ts';
import { useApp } from './app.ts';
import { flagPath } from './paths.ts';
import { sharedSession, type DraftSession } from './draftSession.ts';
import type { Draft } from './lines.ts';

/** This person's draft session in one environment, without re-rendering on its changes (for write paths that only
 *  tell it what they changed). */
export function useDraftSession(env: string): DraftSession {
  const { user, meta } = useApp();
  return sharedSession(user, env, api, meta.environments.map((e) => e.key));
}

/** This person's draft in one environment: the session, and the draft as people read it. Re-renders when it changes;
 *  what the person should hear about keeping it (an old draft dropped, a full browser) comes as a toast, once. */
export function useDraft(env: string) {
  const { meta, toast } = useApp();
  const session = useDraftSession(env);
  const summary = useSyncExternalStore(session.subscribe, () => session.summary(meta));
  useEffect(() => { for (const n of session.takeNotices()) toast(n.message, 'err'); }, [session, summary, toast]);
  return { session, summary };
}

/** What the person should hear about keeping their drafts, in every environment, wherever they are in the console:
 *  an old saved draft that was dropped, or a browser that refused to save one (storage full or off). The app mounts
 *  it once (main.tsx), so a draft written after its page closed is still reported; each notice is said once. */
export function useDraftNotices() {
  const { meta, user, toast } = useApp();
  useEffect(() => {
    const envs = meta.environments.map((e) => e.key);
    const offs = envs.map((env) => {
      const session = sharedSession(user, env, api, envs);
      // after the change that raised it has finished rendering, never during it
      const tell = () => queueMicrotask(() => { for (const n of session.takeNotices()) toast(n.message, 'err'); });
      tell();
      return session.subscribe(tell);
    });
    return () => { for (const off of offs) off(); };
  }, [meta.environments, user, toast]);
}

/**
 * One flag of the draft, opened: the server's copy (the console's last one shows at once) and any saved draft of it.
 * The open flag is keyed by `${flagKey}:${env}`: FlagPage mounts its editor under that key, so another flag or
 * environment is a fresh state, never the last one reset. A change anywhere (the events stream) brings a fresh copy;
 * your edits are kept.
 */
export function useDraftFlag(env: string, flagKey: string) {
  const { meta, toast, revisionTick } = useApp();
  const session = useDraftSession(env);
  // the console's last copy of the flag (paths.ts fetched it before navigating here): the first paint shows it
  const known = useMemo(() => peek<FlagDetail>(flagPath(flagKey)), [flagKey]);
  const view = useSyncExternalStore(session.subscribe, () => session.view(flagKey, meta, known));
  // a failed reload says so in a toast while the page has a copy to show; the first one shows on the page
  const reload = useCallback(() => session.refresh(flagKey).catch((e: Error) => {
    if (session.loaded(flagKey)) toast(`Couldn’t refresh ${flagKey}: ${e.message}`, 'err');
  }), [session, flagKey, toast]);
  useLayoutEffect(() => {
    const close = session.open(flagKey, known);
    void reload();
    return close;
  }, [session, flagKey, known, reload]);
  const seen = useRef(revisionTick);
  useEffect(() => {
    if (seen.current === revisionTick) return;
    seen.current = revisionTick;
    void reload();
  }, [revisionTick, reload]);
  const edit = useCallback((change: (d: Draft) => Draft) => session.edit(flagKey, change), [session, flagKey]);
  return { view, session, reload, edit };
}

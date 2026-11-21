// Tells the console about every publish, so open pages refresh (GET /api/events), and the plugins' live readers, so
// apps fetch their flags again at once (OFREP's GET /ofrep/v1/events, ofrep.ts, which tells only the streams whose answers
// may have changed: it compares the snapshots before and after, and reads the publish's scope). It fires in every
// server process for each publish: its own, and those of other processes it catches up with (workers.ts).

/** Whose answers a publish may have changed, from what its changes were (journal.ts scopeOf). null: anyone's in the
 *  environment. Otherwise `entities`: these entities and those under them (their settings, or their place); `links`:
 *  these entities' app links were replaced (their old link and token stop working). Both empty: nobody's, such as a
 *  new entity (nobody asks as it yet) or a flag's description. The CDN purge drops only those files (cdn.ts), and the
 *  event streams wake only those devices (ofrep.ts). */
export type PublishScope = { entities: string[]; links: string[] } | null;
export const NOBODY: NonNullable<PublishScope> = Object.freeze({ entities: [], links: [] }) as NonNullable<PublishScope>;
/** Both scopes at once: null (anyone's) when either is. */
export function joinScopes(a: PublishScope, b: PublishScope): PublishScope {
  if (!a || !b) return null;
  return { entities: [...new Set([...a.entities, ...b.entities])], links: [...new Set([...a.links, ...b.links])] };
}

export class EventHub {
  console = new Set<(event: string, data: unknown) => void>();
  readers = new Set<(environment: string, revision: number, scope: PublishScope) => void>();

  subscribeConsole(fn: (event: string, data: unknown) => void) {
    this.console.add(fn);
    return () => this.console.delete(fn);
  }

  /** Every publish this process hears of: which environment, at which revision, and whose answers it may have changed
   *  since the one before it heard of. Returns the way to stop listening. */
  subscribe(fn: (environment: string, revision: number, scope: PublishScope) => void) {
    this.readers.add(fn);
    return () => this.readers.delete(fn);
  }

  publish(environment: string, revision: number, scope: PublishScope = null) {
    for (const fn of this.console) fn('revision', { environment, revision });
    for (const fn of this.readers) fn(environment, revision, scope);
  }
}

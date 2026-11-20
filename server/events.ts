// Tells the console about every publish, so open pages refresh (GET /api/events), and the plugins' live readers, so
// apps fetch their flags again at once (OFREP's GET /ofrep/v1/events, ofrep.ts, which tells only the streams whose answers
// may have changed: it compares the snapshots before and after). It fires in every server process for
// each publish: its own, and those of other processes it catches up with (workers.ts).

export class EventHub {
  console = new Set<(event: string, data: unknown) => void>();
  readers = new Set<(environment: string, revision: number) => void>();

  subscribeConsole(fn: (event: string, data: unknown) => void) {
    this.console.add(fn);
    return () => this.console.delete(fn);
  }

  /** Every publish this process hears of: which environment, at which revision. Returns the way to stop listening. */
  subscribe(fn: (environment: string, revision: number) => void) {
    this.readers.add(fn);
    return () => this.readers.delete(fn);
  }

  publish(environment: string, revision: number) {
    for (const fn of this.console) fn('revision', { environment, revision });
    for (const fn of this.readers) fn(environment, revision);
  }
}

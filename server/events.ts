// Tells the console about every publish, so open pages refresh (GET /api/events), and OpenFeature's providers, so apps
// fetch their flags again at once (GET /ofrep/v1/events, ofrep.ts).

export class EventHub {
  console = new Set<(event: string, data: unknown) => void>();
  ofrep = new Set<(environment: string, revision: number) => void>();

  subscribeConsole(fn: (event: string, data: unknown) => void) {
    this.console.add(fn);
    return () => this.console.delete(fn);
  }

  subscribeOfrep(fn: (environment: string, revision: number) => void) {
    this.ofrep.add(fn);
    return () => this.ofrep.delete(fn);
  }

  publish(environment: string, revision: number) {
    for (const fn of this.console) fn('revision', { environment, revision });
    for (const fn of this.ofrep) fn(environment, revision);
  }
}

// The first-run checklist (setup.tsx): which steps are done, read from /meta, and where to go for the next one.
// Apart from setup.tsx so that an edit to its components swaps in place in `pnpm dev` (React Fast Refresh), and so the
// Node tests can check it.
import type { Meta } from '../api.ts';

export type SetupStep = {
  key: 'environments' | 'services' | 'flag' | 'app';
  title: string;
  text: string;
  /** known to be done; a step the console can't see (connecting an app) is never marked done */
  done: boolean;
  /** where to go for it, and the link's words; none while an earlier step has to come first */
  href?: string;
  action?: string;
};

type SetupFacts = Pick<Meta, 'environments' | 'projects' | 'dimensions' | 'entities'> & { plugins?: string[] };

/**
 * The steps from a new server to an app reading its first flag. `flags`: how many flags there are, when the page knows
 * (the Flags list); without it the flag step is never marked done.
 */
export function setupSteps(meta: SetupFacts, flags?: number): SetupStep[] {
  // what this server serves (server/plugin.ts); an older server doesn't say, and serves both
  const ofrep = meta.plugins?.includes('ofrep') ?? true;
  return [
    { key: 'environments', title: 'Environments', done: meta.environments.length > 0, href: '#/settings', action: 'Add an environment',
      text: 'Where flags live, such as Development and Production. Production can require an approval for every change.' },
    { key: 'services', title: 'Services', done: meta.projects.length > 0, href: '#/settings', action: 'Add a service',
      text: 'What reads your flags: each of your apps (web, iOS, Android) and each backend. Each one reads only the flags you put in it.' },
    { key: 'flag', title: 'Your first flag', done: (flags ?? 0) > 0, href: '#/flags', action: 'New flag',
      text: 'An on/off switch, a value that differs per entry, or a release that reaches a % of devices step by step. Tick the services that read it.' },
    { key: 'app', title: 'Connect an app', done: false, href: '#/keys', action: 'API keys',
      text: ofrep
        ? 'Make a key for the app’s service and environment, and give it to OpenFeature’s OFREP provider. An app’s key reads values only; a backend’s key stays secret.'
        : 'Make a key for each backend. Apps read their file at an entry’s app link.' },
  ];
}

/** The step to do next: the first one not done (the last one, connecting an app, once the rest are). */
export const nextStep = (steps: SetupStep[]) => steps.find((s) => !s.done) ?? steps[steps.length - 1];

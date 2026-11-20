// The first-run checklist (setup.tsx): which steps are done, read from /meta, and where to go for the next one.
// Apart from setup.tsx so that an edit to its components swaps in place in `pnpm dev` (React Fast Refresh), and so the
// Node tests can check it.
import { title, type Meta } from '../api.ts';
import { dimensionHref, entityHref } from '../paths.ts';

export type SetupStep = {
  key: 'environments' | 'flag-sets' | 'entries' | 'flag' | 'app';
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
  const top = meta.dimensions[0];
  const first = meta.entities[0];
  // what this server serves (server/plugin.ts); an older server doesn't say, and serves both
  const ofrep = meta.plugins?.includes('ofrep') ?? true;
  return [
    { key: 'environments', title: 'Environments', done: meta.environments.length > 0, href: '#/settings', action: 'Add an environment',
      text: 'Where flags live, such as Development and Production. Production can require an approval for every change.' },
    { key: 'flag-sets', title: 'Flag sets', done: meta.projects.length > 0, href: '#/settings', action: 'Add a flag set',
      text: 'The groups flags are sent in: one for each of your web, iOS and Android apps, and one for each backend.' },
    { key: 'entries', title: 'Dimensions and a first entry', done: meta.dimensions.length > 0 && meta.entities.length > 0,
      href: top ? dimensionHref(top.key) : '#/settings/dimensions', action: top ? `Open ${title(top)}` : 'Set up dimensions',
      text: 'What config is served per, in your own words (one level, or a chain such as region › chain › store), and one entry in it. Each entry has its own app link.' },
    { key: 'flag', title: 'Your first flag', done: (flags ?? 0) > 0, href: '#/flags', action: 'New flag',
      text: 'An on/off switch, a value that differs per entry, or a release that reaches a % of devices step by step.' },
    { key: 'app', title: 'Connect an app', done: false,
      ...(first ? { href: entityHref(first.dimension, first.key), action: `Open ${first.name}` } : {}),
      text: ofrep
        ? 'Open an entry’s page, then App link, then Copy token. The app’s OpenFeature provider (OFREP) sends it with each request. Backends use an API key.'
        : 'Open an entry’s page, then App link, then Copy link. The app reads its file there. Backends use an API key.' },
  ];
}

/** The step to do next: the first one not done (the last one, connecting an app, once the rest are). */
export const nextStep = (steps: SetupStep[]) => steps.find((s) => !s.done) ?? steps[steps.length - 1];

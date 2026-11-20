// The first-run checklist (setup.tsx): which steps are done, read from /meta, and where to go for the next one.
// Apart from setup.tsx so that an edit to its components swaps in place in `pnpm dev` (React Fast Refresh), and so the
// Node tests can check it.
import type { Meta } from '../api.ts';

export type SetupStep = {
  key: 'environments' | 'services' | 'flag' | 'app';
  title: string;
  text: string;
  /** known to be done: connecting an app is done once any key in use has read flags (/meta keyLastUsedAt) */
  done: boolean;
  /** where to go for it, and the link's words; none while an earlier step has to come first */
  href?: string;
  action?: string;
};

type SetupFacts = Pick<Meta, 'environments' | 'services' | 'dimensions' | 'plugins'> & Partial<Pick<Meta, 'keyLastUsedAt'>>;

/**
 * The steps from a new server to an app reading its first flag. Dimensions are optional, so they aren't a step, and the
 * steps never name an entity before a dimension exists. `flags`: how many flags there are, when the page knows (the
 * Flags list); without it the flag step is never marked done.
 */
export function setupSteps(meta: SetupFacts, flags?: number): SetupStep[] {
  // what this server serves (server/plugin.ts)
  const ofrep = meta.plugins.includes('ofrep');
  // the top dimension's word, when there is one ("store"); before that, no word for it at all
  const top = meta.dimensions[0]?.singular;
  return [
    { key: 'environments', title: 'Environments', done: meta.environments.length > 0, href: '#/settings/environments', action: 'Add an environment',
      text: 'Where flags live, such as Development and Production. Production can require an approval for every change.' },
    { key: 'services', title: 'Services', done: meta.services.length > 0, href: '#/services', action: 'Add a service',
      text: 'What reads your flags: each of your apps (web, iOS, Android) and each backend. Each one reads only the flags you put in it.' },
    { key: 'flag', title: 'Your first flag', done: (flags ?? 0) > 0, href: '#/flags', action: 'New flag',
      text: `An on/off switch, a value that differs per ${top ?? 'user or device'}, or a release that reaches a % of devices step by step. Tick the services that read it.` },
    { key: 'app', title: 'Connect an app', done: !!meta.keyLastUsedAt, href: '#/keys', action: 'API keys',
      text: ofrep
        ? 'Make a key for the app’s service and environment, and give it to OpenFeature’s OFREP provider. An app’s key reads values only; a backend’s key stays secret. This is done once an app reads with it.'
        : top
          ? `Make a key for each backend. Apps read their file at a ${top}’s app link, or their service’s file for everyone.`
          : 'Make a key for each backend. Apps read their service’s file for everyone (Settings → Services).' },
  ];
}

/** Whether there is anything left to set up: the Flags list shows the checklist only while a step isn't done. */
export const setupLeft = (steps: SetupStep[]) => steps.some((s) => !s.done);

/** The step to do next: the first one not done (the last one, connecting an app, once the rest are). */
export const nextStep = (steps: SetupStep[]) => steps.find((s) => !s.done) ?? steps[steps.length - 1];

/** "Four steps, and your apps read their first flag." Counted from the steps, so the welcome never miscounts. */
export function stepsLead(steps: SetupStep[]): string {
  const words = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
  const n = words[steps.length] ?? String(steps.length);
  return `${n} ${steps.length === 1 ? 'step' : 'steps'}, and your apps read their first flag.`;
}

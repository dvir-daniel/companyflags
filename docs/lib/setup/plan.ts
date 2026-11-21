// What the setup builder shows: numbered steps, each with a title, short paragraphs, an optional list, and code blocks
// with a language and a file name. Prose uses three marks only: `code`, **bold** and [text](/link) (see inline.ts).
// The settings a setup uses are listed too, so a test can check each one is a setting the server reads.

import type { Choices } from './choices.ts';

export type Lang = 'bash' | 'yaml' | 'json' | 'dockerfile' | 'sql' | 'js' | 'text';

export type Code = { lang: Lang; filename: string; code: string };

export type Step = {
  id: string;
  title: string;
  prose: string[];
  list?: string[];
  code: Code[];
  /** A short line under the code, such as a check to run. */
  after?: string[];
};

/** A setting the setup gives the server. `secret`: made by a command in the steps and kept in the platform's secret
 *  store, never written out. `compose`: read by Docker Compose, not by the server. */
export type Setting = { name: string; value: string; secret?: boolean; compose?: boolean };

export type Link = { label: string; url: string };

export type Plan = {
  choices: Choices;
  /** One line: what this setup builds. */
  summary: string;
  steps: Step[];
  settings: Setting[];
  /** The full recipe for this platform. */
  recipe: Link;
};

/** A step, with its id made from the title. */
export const step = (title: string, parts: Omit<Step, 'id' | 'title' | 'code'> & { code?: Code[] }): Step => ({
  id: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
  title,
  ...parts,
  code: parts.code ?? [],
});

export const bash = (code: string, filename = 'Terminal'): Code => ({ lang: 'bash', filename, code: code.trim() });
export const file = (lang: Lang, filename: string, code: string): Code => ({ lang, filename, code: code.trim() });

/** Lines without the ones left empty by a choice that adds nothing: `lines('a', c && 'b', 'c')`. */
export const lines = (...parts: (string | false | null | undefined)[]) => parts.filter((p): p is string => typeof p === 'string').join('\n');

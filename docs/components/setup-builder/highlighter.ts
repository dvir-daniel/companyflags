// The setup builder's code colors: Shiki with only the languages the steps use and the site's two themes (the same
// github-light and github-dark as the pages' own code), loaded once, when the first code block needs it.
import type { HighlighterCore } from 'shiki/core';

let shiki: Promise<HighlighterCore> | undefined;

export function highlighter(): Promise<HighlighterCore> {
  shiki ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([import('shiki/core'), import('shiki/engine/javascript')]);
    return createHighlighterCore({
      langs: [
        import('shiki/langs/shellscript.mjs'), import('shiki/langs/yaml.mjs'), import('shiki/langs/json.mjs'),
        import('shiki/langs/docker.mjs'), import('shiki/langs/sql.mjs'), import('shiki/langs/javascript.mjs'),
      ],
      themes: [import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark.mjs')],
      engine: createJavaScriptRegexEngine(),
    });
  })();
  return shiki;
}

export const THEMES = { themes: { light: 'github-light', dark: 'github-dark' } } as const;

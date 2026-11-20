// The console's colors as packages/ui/src/styles.css sets them: the edge of a control (an input, a checkbox, a switch)
// reads at 3:1 on every surface it sits on (WCAG 1.4.11), and small text in the quiet grey at 4.5:1, in both themes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { contrast } from '../server/appearance.ts';

const css = readFileSync(new URL('../packages/ui/src/styles.css', import.meta.url), 'utf8');
/** One theme's block of variables: `:root,\n[data-theme="light"] {…}` or `[data-theme="dark"] {…}`. */
function theme(name: 'light' | 'dark'): Record<string, string> {
  const start = css.indexOf(`[data-theme="${name}"] {`);
  const body = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\b/g)].map((m) => [m[1], m[2]]));
}

for (const name of ['light', 'dark'] as const) {
  test(`${name}: controls' edges read at 3:1, quiet text at 4.5:1`, () => {
    const t = theme(name);
    for (const surface of ['page', 'panel', 'panel-2']) {
      assert.ok(contrast(t['control-edge'], t[surface]) >= 3, `control edge on ${surface}: ${contrast(t['control-edge'], t[surface]).toFixed(2)}`);
    }
    for (const surface of ['page', 'panel']) {
      assert.ok(contrast(t['ink-3'], t[surface]) >= 4.5, `ink-3 on ${surface}: ${contrast(t['ink-3'], t[surface]).toFixed(2)}`);
    }
  });
}

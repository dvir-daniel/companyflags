// The setup builder's generator: answers in, numbered steps out. Pure functions with no React, so the docs' client
// component only renders what generate() returns, and test/setup-builder.test.ts checks every combination.
//
//   const choices = fromQuery(location.search);   // or normalize({ where: 'aws', cdnHost: true, cdn: 'cloudfront' })
//   const plan = generate(choices);               // { summary, steps: [{ title, prose, list, code: [{ lang, filename, code }] }], settings, recipe }
//   history.replaceState(null, '', `?${toQuery(choices)}`);

import { awsPlan } from './aws.ts';
import { azurePlan } from './azure.ts';
import { normalize, type Choices } from './choices.ts';
import { composePlan } from './compose.ts';
import { googlePlan } from './google.ts';
import { kubernetesPlan } from './kubernetes.ts';
import type { Plan } from './plan.ts';

export * from './choices.ts';
export type { Code, Lang, Link, Plan, Setting, Step } from './plan.ts';
export { RECIPES } from './common.ts';

/** The steps for a set of answers. The answers are normalized first, so any input gives a valid setup. */
export function generate(input: Partial<Choices>): Plan {
  const c = normalize(input);
  switch (c.where) {
    case 'compose': return composePlan(c);
    case 'kubernetes': return kubernetesPlan(c);
    case 'aws': return awsPlan(c);
    case 'google': return googlePlan(c);
    case 'azure': return azurePlan(c);
  }
}

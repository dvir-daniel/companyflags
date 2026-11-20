// JSONata (https://jsonata.org): the one way to reshape JSON in and out of CompanyFlags, for imports, exports and
// webhooks (values.ts, webhooks.ts). An expression reads its input and makes a new value; it can't read files, the
// network or anything else on the server, and it gets a time and depth limit here, so a slow or endless one stops.

import jsonata from 'jsonata';
import { HttpError } from './db.ts';

export const EXPRESSION_MAX = 10_000;
export type Limits = { timeoutMs: number; maxDepth: number };
const LIMITS: Limits = { timeoutMs: 1000, maxDepth: 500 };

type Compiled = ReturnType<typeof jsonata>;
const where = (e: { position?: number }) => (typeof e.position === 'number' ? ` (at character ${e.position})` : '');

function compile(expression: unknown): Compiled {
  if (typeof expression !== 'string' || !expression.trim()) throw new HttpError(422, 'Add the JSONata expression.');
  if (expression.length > EXPRESSION_MAX) throw new HttpError(422, `The JSONata expression is longer than ${EXPRESSION_MAX} characters.`);
  try {
    return jsonata(expression);
  } catch (e) {
    throw new HttpError(422, `The JSONata expression doesn’t read: ${(e as Error).message}${where(e as { position?: number })}`);
  }
}

/** Why the expression can't be used, or null. Checked before it's saved. */
export function expressionProblem(expression: unknown): string | null {
  try { compile(expression); return null; } catch (e) { return (e as Error).message; }
}

/** The expression's result for this input. Throws 422 with the words to show when it doesn't read, fails or runs over. */
export async function runJsonata(expression: unknown, input: unknown, limits: Limits = LIMITS): Promise<unknown> {
  const expr = compile(expression);
  const start = Date.now();
  let depth = 0;
  const check = () => {
    if (depth > limits.maxDepth) throw new Error(`it went more than ${limits.maxDepth} levels deep (does a function call itself without end?)`);
    if (Date.now() - start > limits.timeoutMs) throw new Error(`it ran longer than ${limits.timeoutMs} ms`);
  };
  // JSONata calls these before and after each step it evaluates
  const bind = expr.assign as unknown as (name: symbol, value: unknown) => void;
  bind.call(expr, Symbol.for('jsonata.__evaluate_entry'), () => { depth++; check(); });
  bind.call(expr, Symbol.for('jsonata.__evaluate_exit'), () => { depth--; check(); });
  try {
    return await expr.evaluate(input);
  } catch (e) {
    throw new HttpError(422, `The JSONata expression failed: ${(e as Error).message}${where(e as { position?: number })}`);
  }
}

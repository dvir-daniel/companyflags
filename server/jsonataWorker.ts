// A JSONata expression, run in a worker thread of its own (transform.ts starts it): one that takes all the memory or
// never ends (a built-in on a huge list, a regular expression that backtracks without end) stops this worker, never
// the server. Between its steps, the expression also has the time and depth limit it is given.

import { parentPort } from 'node:worker_threads';
import jsonata from 'jsonata';

/** What transform.ts sends: the expression, its input as JSON (none: undefined), its limits, and the most JSON its
 *  result may be. */
export type Job = { expression: string; input?: string; timeoutMs: number; maxDepth: number; outputMax: number };
/** What comes back: the result as JSON (none: undefined), or why it failed. */
export type Reply = { ok: true; output?: string } | { ok: false; message: string; position?: number };

async function run(job: Job): Promise<Reply> {
  const start = Date.now();
  let depth = 0;
  const check = () => {
    if (depth > job.maxDepth) throw new Error(`it went more than ${job.maxDepth} levels deep (does a function call itself without end?)`);
    if (Date.now() - start > job.timeoutMs) throw new Error(`it ran longer than ${job.timeoutMs} ms`);
  };
  try {
    const expr = jsonata(job.expression);
    // JSONata calls these before and after each step it evaluates
    const bind = expr.assign as unknown as (name: symbol, value: unknown) => void;
    bind.call(expr, Symbol.for('jsonata.__evaluate_entry'), () => { depth++; check(); });
    bind.call(expr, Symbol.for('jsonata.__evaluate_exit'), () => { depth--; check(); });
    const value = await expr.evaluate(job.input === undefined ? undefined : JSON.parse(job.input));
    const output = value === undefined ? undefined : JSON.stringify(value);
    if (output !== undefined && output.length > job.outputMax) {
      return { ok: false, message: `its result is larger than ${Math.round(job.outputMax / 1_000_000)} MB` };
    }
    return { ok: true, output };
  } catch (e) {
    const err = e as { message?: string; position?: number };
    return { ok: false, message: err.message ?? String(e), ...(typeof err.position === 'number' ? { position: err.position } : {}) };
  }
}

parentPort?.on('message', (job: Job) => {
  void run(job).then((r) => parentPort!.postMessage(r));
});

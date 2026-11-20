// JSONata (https://jsonata.org): the one way to reshape JSON in and out of CompanyFlags, for imports, exports and
// webhooks (values.ts, webhooks.ts). An expression reads its input and makes a new value; it can't read files, the
// network or anything else on the server. It runs in a worker thread (jsonataWorker.ts) with a memory limit, and is
// stopped when it runs too long, so an expression that takes all the memory or never ends (a built-in on a huge
// list, a regular expression that backtracks without end) stops only its worker: the server goes on answering.

import { Worker } from 'node:worker_threads';
import jsonata from 'jsonata';
import { HttpError } from './db.ts';
import type { Job, Reply } from './jsonataWorker.ts';

export const EXPRESSION_MAX = 10_000;
/** The most JSON an expression reads or makes, in characters. */
export const DATA_MAX = 4_000_000;
export type Limits = { timeoutMs: number; maxDepth: number };
const LIMITS: Limits = { timeoutMs: 1000, maxDepth: 500 };

/** An expression that ran over a limit: too long, too much memory, too large a result. Webhooks switch off on it
 *  (webhooks.ts) instead of trying again. */
export class ExpressionLimitError extends HttpError {}

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

// ---------------------------------------------------------------- the workers

// beside this file: the .ts in the repository, the .js the package builds (packages/companyflags)
const WORKER = new URL(import.meta.url.endsWith('.ts') ? './jsonataWorker.ts' : './jsonataWorker.js', import.meta.url);
/** Each worker's memory, in MB: a little more than DATA_MAX of JSON needs. */
const RESOURCES = { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 };
/** Workers at once, and expressions waiting for one before more are turned away. */
const WORKERS = 2;
const WAITING_MAX = 100;
/** A worker gets this long past the expression's own time limit (its start, a step that doesn't return) before it is
 *  stopped. */
const GRACE_MS = 1000;

const idle: Worker[] = [];
let running = 0;
const waiting: (() => void)[] = [];

function spawn(): Worker {
  const w = new Worker(WORKER, { resourceLimits: RESOURCES });
  w.on('exit', () => { const i = idle.indexOf(w); if (i >= 0) idle.splice(i, 1); });
  w.on('error', () => {});                                 // said by the job it was running (run, below)
  return w;
}

async function turn(): Promise<void> {
  if (running < WORKERS) { running++; return; }
  if (waiting.length >= WAITING_MAX) throw new HttpError(503, 'Too many JSONata expressions are running: try again in a moment.');
  await new Promise<void>((go) => waiting.push(go));       // the turn is handed over as it is (release)
}
function release() {
  const next = waiting.shift();
  if (next) next(); else running--;
}

/** Runs one job on a worker: its reply, or why the worker was stopped. A worker that was stopped is never used again. */
function run(job: Job): Promise<Reply> {
  const worker = idle.pop() ?? spawn();
  return new Promise<Reply>((resolve) => {
    let settled = false;
    const finish = (r: Reply, keep: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.off('message', onMessage).off('error', onError).off('exit', onExit);
      if (keep) { worker.unref(); idle.push(worker); } else void worker.terminate();
      resolve(r);
    };
    const onMessage = (r: Reply) => finish(r, true);
    const onError = (e: Error & { code?: string }) => finish({ ok: false, message: e.code === 'ERR_WORKER_OUT_OF_MEMORY'
      ? 'it needed more memory than an expression may use' : e.message }, false);
    const onExit = () => finish({ ok: false, message: 'it stopped before it finished' }, false);
    const timer = setTimeout(() => finish({ ok: false, message: `it ran longer than ${job.timeoutMs} ms` }, false), job.timeoutMs + GRACE_MS);
    worker.on('message', onMessage).on('error', onError).on('exit', onExit);
    worker.ref();
    worker.postMessage(job);
  });
}

/** Whether a failure is the expression running over a limit, rather than a mistake in it. */
const OVER = /^(it ran longer than|it needed more memory|it went more than|its result is larger than|it stopped before)/;

/** The expression's result for this input. Throws 422 with the words to show when it doesn't read, fails or runs over
 *  (ExpressionLimitError when it runs over). */
export async function runJsonata(expression: unknown, input: unknown, limits: Limits = LIMITS): Promise<unknown> {
  compile(expression);                                     // its mistakes in its own words, before a worker starts
  const json = input === undefined ? undefined : JSON.stringify(input);
  if (json !== undefined && json.length > DATA_MAX) {
    throw new HttpError(422, `The JSONata expression’s input is larger than ${DATA_MAX / 1_000_000} MB.`);
  }
  await turn();
  let r: Reply;
  try {
    r = await run({ expression: expression as string, input: json, timeoutMs: limits.timeoutMs, maxDepth: limits.maxDepth, outputMax: DATA_MAX });
  } finally {
    release();
  }
  if (!r.ok) {
    const message = `The JSONata expression failed: ${r.message}${where(r)}`;
    throw OVER.test(r.message) ? new ExpressionLimitError(422, message) : new HttpError(422, message);
  }
  return r.output === undefined ? undefined : JSON.parse(r.output);
}

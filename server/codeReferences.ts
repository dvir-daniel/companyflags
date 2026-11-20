// Code references (the CLI's `flags unused`): which flags no code mentions, and which keys the code reads with
// OpenFeature that aren't flags. A plain search, with no parser: a flag is mentioned when its key is a whole word in
// a text file; a key is read when it is the first argument of an OpenFeature get…Value call.

import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SKIPPED = new Set(['node_modules', '.git', 'dist', 'build']);
const MAX_BYTES = 1024 * 1024;
/** OpenFeature's client calls with a key typed in: getBooleanValue("new_checkout", …), getStringValueDetails(…) */
const READS = /get(?:Boolean|String|Number|Object)Value(?:Details)?\(\s*['"]([a-z][a-z0-9_]*)['"]/g;
const WORDS = /[A-Za-z0-9_]+/g;

export type CodeReferences = {
  /** flags no file mentions */
  unused: string[];
  /** keys the code reads that aren't flags, where */
  unknown: { key: string; file: string; line: number }[];
};

/** Searches `src` for the flag keys. `skip`: files not to read (the flags file itself). */
export function codeReferences(keys: string[], src: string, o: { skip?: string[] } = {}): CodeReferences {
  const flags = new Set(keys);
  const seen = new Set<string>();
  const unknown: CodeReferences['unknown'] = [];
  const skip = new Set((o.skip ?? []).map((f) => resolve(f)));
  for (const file of textFiles(resolve(src), skip)) {
    const text = readFileSync(file, 'utf8');
    if (seen.size < flags.size) for (const [w] of text.matchAll(WORDS)) if (flags.has(w)) seen.add(w);
    for (const m of text.matchAll(READS)) {
      if (flags.has(m[1])) continue;
      unknown.push({ key: m[1], file, line: lineAt(text, m.index) });
    }
  }
  return { unused: keys.filter((k) => !seen.has(k)).sort(), unknown };
}

/** The text files under a folder (or the file itself), in order: not in SKIPPED folders, not over MAX_BYTES, not
 *  links, and without a zero byte in their first 8 KB (a binary file). */
function* textFiles(path: string, skip: Set<string>): Generator<string> {
  const st = statSync(path);
  if (st.isFile()) {
    if (!skip.has(path) && st.size <= MAX_BYTES && !binary(path)) yield path;
    return;
  }
  const entries = readdirSync(path, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const p = join(path, e.name);
    if (e.isDirectory()) { if (!SKIPPED.has(e.name)) yield* textFiles(p, skip); }
    else if (e.isFile()) yield* textFiles(p, skip);
  }
}

function binary(file: string): boolean {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes(0);
  } finally {
    closeSync(fd);
  }
}

const lineAt = (text: string, index: number) => {
  let line = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) line++;
  return line;
};

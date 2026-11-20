// Code references (the CLI's `flags unused`): which flags no code mentions, and which keys the code reads with
// OpenFeature that aren't flags. A plain search, with no parser: a flag is mentioned when its key is a whole word in
// a text file; a key is read when it is the flag key of an OpenFeature call (READS), in each SDK's spelling.

import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Folders of installed packages, builds and caches: what's in them isn't the code's own. */
const SKIPPED = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.turbo', 'coverage', 'vendor', 'target', '.venv', 'venv', '__pycache__']);
const MAX_BYTES = 1024 * 1024;
const KEY = String.raw`['"\x60]([a-z][a-z0-9_]*)['"\x60]`;
const read = (pattern: string) => new RegExp(`${pattern}${KEY}`, 'g');
/** OpenFeature's calls with a key typed in, in each SDK's spelling. The key is the first argument, except in Go
 *  (after the context) and where it is named (Python's flag_key=, Ruby's flag_key:, Swift's key:). */
export const READS: { languages: string; pattern: RegExp }[] = [
  // getBooleanValue('new_checkout', …), getNumberDetails(…), getIntegerValue (Java), getObjectValueDetails
  { languages: 'JavaScript, TypeScript, Java, Kotlin, PHP, Swift',
    pattern: read(String.raw`\bget(?:Boolean|String|Number|Integer|Double|Object)(?:Value|Details|ValueDetails)\(\s*(?:key:\s*)?`) },
  // useBooleanFlagValue('new_checkout', false), useStringFlagDetails(…), useFlag(…), useSuspenseFlag(…)
  { languages: 'React', pattern: read(String.raw`\buse(?:(?:Boolean|String|Number|Object)Flag(?:Value|Details)|Flag|SuspenseFlag)\(\s*`) },
  // client.BooleanValue(ctx, "new_checkout", false, evalCtx), StringValueDetails(context.Background(), …)
  { languages: 'Go', pattern: read(String.raw`\b(?:Boolean|String|Int|Float|Object)(?:Value|ValueDetails)\(\s*[\w.]+(?:\(\))?\s*,\s*`) },
  // get_boolean_value("new_checkout", False), get_integer_details(flag_key="…") (Python); get_bool_value("…") (Rust)
  { languages: 'Python, Rust',
    pattern: read(String.raw`\bget_(?:bool|boolean|string|int|integer|float|object|struct)_(?:value|details)\(\s*(?:flag_key\s*=\s*)?`) },
  // fetch_boolean_value(flag_key: "new_checkout", default_value: false)
  { languages: 'Ruby', pattern: read(String.raw`\bfetch_(?:boolean|string|number|integer|float|object)_(?:value|details)\(\s*(?:flag_key:\s*)?`) },
  // GetBooleanValueAsync("new_checkout", false), GetStringDetailsAsync(…)
  { languages: '.NET', pattern: read(String.raw`\bGet(?:Boolean|String|Integer|Double|Object)(?:Value|Details)Async\(\s*`) },
];
/** flagd JSON (an export, a CDN file) names every flag it has: that isn't the code reading them. */
const FLAGD_FILE = /"\$schema"\s*:\s*"https:\/\/flagd\.dev\/schema\//;
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
    if (file.endsWith('.json') && FLAGD_FILE.test(text.slice(0, 4096))) continue;
    if (seen.size < flags.size) for (const [w] of text.matchAll(WORDS)) if (flags.has(w)) seen.add(w);
    const found: { key: string; at: number }[] = [];
    for (const { pattern } of READS) for (const m of text.matchAll(pattern)) if (!flags.has(m[1])) found.push({ key: m[1], at: m.index });
    for (const f of found.sort((a, b) => a.at - b.at)) unknown.push({ key: f.key, file, line: lineAt(text, f.at) });
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

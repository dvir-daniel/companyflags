// A flag's values as the text people type, and back, with what's wrong with them. The value editors
// (values.tsx) use these; there is no DOM or React here, so the Node tests load it.

export type ValueRow = { key: string; text: string; isNew: boolean };

export function toText(type: string, value: unknown): string {
  if (type === 'string') return String(value ?? '');
  if (type === 'json') return JSON.stringify(value ?? {}, null, 2);
  return String(value ?? '');
}

/** "true" in any case, with spaces around it allowed. */
export const isTrue = (text: string) => text.trim().toLowerCase() === 'true';

/** Why this text isn't a value of the type (null when it is one). fromText and rowError both go by it. */
export function valueError(type: string, text: string): string | null {
  if (type === 'bool') return /^(true|false)$/i.test(text.trim()) ? null : 'Pick true or false';
  if (type === 'number') return text.trim() !== '' && Number.isFinite(Number(text)) ? null : 'Enter a number';
  if (type === 'json') {
    try { JSON.parse(text); } catch { return 'Not valid JSON'; }
  }
  return null;
}

/** The value a text stands for. Throws, with valueError's words, when it isn't one: check rowError first. */
export function fromText(type: string, text: string): unknown {
  const problem = valueError(type, text);
  if (problem) throw new Error(problem);
  if (type === 'bool') return isTrue(text);
  if (type === 'number') return Number(text);
  if (type === 'json') return JSON.parse(text);
  return text;
}

/** What's wrong with a row's name (null when nothing is). */
export function nameError(row: ValueRow, all: ValueRow[]): string | null {
  if (!row.key.trim()) return 'Give this value a name';
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(row.key)) return 'Name: lowercase letters, digits, - and _';
  if (row.key === 'code_default' || row.key.startsWith('val-')) return 'That name is reserved';
  if (all.filter((r) => r.key === row.key).length > 1) return 'Names must be unique';
  return null;
}

/** What's wrong with a row: its name first, then its value (null when nothing is). */
export function rowError(type: string, row: ValueRow, all: ValueRow[]): string | null {
  return nameError(row, all) ?? valueError(type, row.text);
}

export const blankRow = (type: string, existing: ValueRow[]): ValueRow => {
  const text = type === 'bool' ? (existing.some((r) => isTrue(r.text)) ? 'false' : 'true') : type === 'number' ? '0' : type === 'json' ? '{}' : '';
  return { key: '', text, isNew: true };
};

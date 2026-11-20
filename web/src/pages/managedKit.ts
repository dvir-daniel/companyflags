// "Managed in repo" (managedInRepo.tsx): whether a flag is managed from a flags file (server/flagsAsCode.ts), and the
// fields the file owns, in words.
import { useEffect, useState } from 'react';
import { api } from '../api.ts';

export type Managed = { source: string | null; fields: string[]; appliedAt: string; appliedBy: string };

/** The flag's record from its file's last push, or null (not managed, or not loaded yet). */
export function useManaged(flag: string): Managed | null {
  const [got, setGot] = useState<{ flag: string; managed: Managed | null }>({ flag, managed: null });
  useEffect(() => {
    let live = true;
    api<{ managed: Managed | null }>('GET', `/flags-as-code/managed/${encodeURIComponent(flag)}`)
      .then((r) => { if (live) setGot({ flag, managed: r?.managed ?? null }); })
      .catch(() => {});                                   // an older server, or offline: no marker
    return () => { live = false; };
  }, [flag]);
  return got.flag === flag ? got.managed : null;
}

const WORDS: Record<string, string> = {
  name: 'name', description: 'description', owner: 'owner', kind: 'kind', tags: 'tags', removeBy: 'remove-by date',
  variants: 'variants', freeValues: 'free values', jsonSchema: 'JSON Schema', default: 'default', services: 'services',
};

/** "kind, description and variants": the fields the file owns (its kind always), in words. */
export function ownedWords(fields: string[]): string {
  const w = ['kind', ...fields.filter((f) => f !== 'kind')].map((f) => WORDS[f] ?? f);
  return w.length === 1 ? w[0] : `${w.slice(0, -1).join(', ')} and ${w[w.length - 1]}`;
}

// What the API keys page (Keys.tsx) says and shows: what a key may ask about, in the installation's words, and the
// code to read flags with a new key, filled in. Apart from Keys.tsx so that an edit to its components swaps in place in
// `pnpm dev` (React Fast Refresh), and so the Node tests can check it. No SDK of our own: the snippets are curl and
// OpenFeature's own providers.
import type { Dimensions } from '../../../server/dimensions.ts';
import { joined } from '../../../server/dimensions.ts';

/** "company or brand" for the dimensions, or '' when there are none. */
const what = (dims: Dimensions) => joined(dims, 'or').toLowerCase();

/** What each scope means, in the installation's words. With no dimension there is nothing to narrow a key to. */
export function scopeHints(dims: Dimensions): Record<string, string> {
  const w = what(dims);
  if (!w) return { all: 'The key reads every flag in its service. Add a dimension to make keys for one part of it.', entity: '', below: '' };
  return {
    entity: `The key asks about one ${w} only.`,
    below: `The key asks about one ${w}, or any under it: each request names which (in the context, or the address).`,
    all: `The key asks about any ${w}: each request names which (in the context, or the address).`,
  };
}

/** The scope choices: "Any company or brand", "Only one", "One and everything under it" ("Any" with no dimension). */
export const scopeAnyLabel = (dims: Dimensions) => (what(dims) ? `Any ${what(dims)}` : 'Any');

/** What a new key starts with, until it is changed: an app's key is public, so it asks about one entity (when there
 *  is one to pick) and works for a year; a backend's is secret, kept on the server, and asks about any, until revoked.
 *  `days` 0: until revoked. */
export function keyDefaults(kind: 'client' | 'server' | undefined, entities: number): { scope: 'all' | 'entity'; days: number } {
  return kind === 'client' ? { scope: entities > 0 ? 'entity' : 'all', days: 365 } : { scope: 'all', days: 0 };
}

/** A flag to show in the snippets: its key and type, or none when the service has no flag yet. */
export type SnippetFlag = { key: string; valueType: string } | null;

export type SnippetFacts = {
  /** the server's address, as the browser reaches it (location.origin) */
  origin: string;
  /** the new key, in full (shown once) */
  key: string;
  /** the service's kind: an app ('client') or a backend ('server') */
  kind: string;
  /** the plugins this server runs (meta.plugins) */
  plugins: string[];
  flag: SnippetFlag;
  /** a backend key's flagd JSON address, when it names one entity (Keys.tsx flagdAddress); null for any */
  flagdPath: string | null;
};

export type Snippet = { id: 'curl' | 'web' | 'node' | 'flagd'; label: string; code: string };

const READ: Record<string, [string, string]> = {
  bool: ['getBooleanValue', 'false'], string: ['getStringValue', '\'\''], number: ['getNumberValue', '0'], json: ['getObjectValue', '{}'],
};

/**
 * Ready-to-run code for a new key: a curl of OFREP's bulk answer, then OpenFeature's OFREP provider for a web app or a
 * Node backend, and a backend's flagd JSON download. Each has the server's address and the key filled in.
 */
export function keySnippets(f: SnippetFacts): Snippet[] {
  const out: Snippet[] = [];
  const auth = `Authorization: Bearer ${f.key}`;
  const flagKey = f.flag?.key ?? 'my_flag';
  const [reader, fallback] = READ[f.flag?.valueType ?? 'bool'] ?? READ.bool;
  if (f.plugins.includes('ofrep')) {
    out.push({ id: 'curl', label: 'curl', code: [
      `curl -X POST ${f.origin}/ofrep/v1/evaluate/flags \\`,
      `  -H "${auth}" -H "Content-Type: application/json" \\`,
      `  -d '{"context": {"targetingKey": "device-1"}}'`,
    ].join('\n') });
    if (f.kind === 'client') {
      out.push({ id: 'web', label: 'Web app (OFREP)', code: [
        `import { OpenFeature } from '@openfeature/web-sdk';`,
        `import { OFREPWebProvider } from '@openfeature/ofrep-web-provider';`,
        '',
        `await OpenFeature.setContext({ targetingKey: 'device-1' });`,
        'await OpenFeature.setProviderAndWait(new OFREPWebProvider({',
        `  baseUrl: '${f.origin}',`,
        `  headers: [['Authorization', 'Bearer ${f.key}']],`,
        '}));',
        `OpenFeature.getClient().${reader}('${flagKey}', ${fallback});`,
      ].join('\n') });
    } else {
      out.push({ id: 'node', label: 'Node backend (OFREP)', code: [
        `import { OpenFeature } from '@openfeature/server-sdk';`,
        `import { OFREPProvider } from '@openfeature/ofrep-provider';`,
        '',
        '// a backend’s key is secret: keep it in the server’s environment, e.g. FLAGS_API_KEY',
        'await OpenFeature.setProviderAndWait(new OFREPProvider({',
        `  baseUrl: '${f.origin}',`,
        `  headers: [['Authorization', 'Bearer ${f.key}']],`,
        '}));',
        `await OpenFeature.getClient().${reader}('${flagKey}', ${fallback}, { targetingKey: 'user-1' });`,
      ].join('\n') });
    }
  }
  if (f.kind !== 'client' && f.flagdPath && f.plugins.includes('flagd')) {
    out.push({ id: 'flagd', label: 'flagd JSON', code: `curl ${f.origin}${f.flagdPath} \\\n  -H "${auth}"` });
  }
  return out;
}

// What the Migration page (Migration.tsx) shares: the server's shapes (server/values.ts, server/webhooks.ts), the
// formats' words, and a file download. Apart from the page so that an edit to its components swaps in place.

export type Line = { flag: string; entity: string | null; text: string };
export type Plan = { environment: string; review: boolean; create: Line[]; changes: Line[]; unchanged: number; problems: string[]; warnings: string[] };
export type Imported = { created: number; changed: number; applied: boolean; revision?: number; request?: number; warnings: string[] };

export type WebhookOut = {
  id: number; name: string; host: string; method: string; headerNames: string[]; format: string; expression: string | null;
  events: string[]; environments: string[] | null; enabled: boolean; createdAt: string; createdBy: string;
  lastStatus: number | null; lastError: string | null; lastSentAt: string | null; lastFailedAt: string | null; attempts: number; nextAttemptAt: string | null;
};
export type WebhookIn = {
  id: number; name: string; environment: string; format: string; expression: string | null; createFlags: boolean; flagSets: string[]; enabled: boolean;
  createdAt: string; createdBy: string; lastReceivedAt: string | null; lastStatus: number | null; lastResult: string | null;
};
export type WebhookList = { reachable: boolean; webhooks: WebhookOut[]; incoming: WebhookIn[] };
export const WEBHOOKS_PATH = '/webhooks';

export const FORMATS_IN: [string, string][] = [
  ['kv', 'Key-value JSON'], ['flagd', 'flagd (OpenFeature)'], ['values', 'CompanyFlags values'], ['jsonata', 'Any JSON, with JSONata'],
];
export const FORMAT_HINT: Record<string, string> = {
  kv: '{ "max_upload_mb": 100, "new_checkout": true }: each flag’s value for everyone.',
  flagd: 'OpenFeature’s flag file. Each flag’s default and on/off come over; its targeting doesn’t.',
  values: 'Each flag’s value for everyone, on/off, variants and entities’ own values. What an export gives.',
  jsonata: 'Any other shape: a JSONata expression makes a values document of it.',
};
export const OUT_FORMATS: [string, string][] = [['json', 'JSON, signed'], ['slack', 'Slack message'], ['jsonata', 'JSON made with JSONata']];
export const OUT_FORMAT_HINT: Record<string, string> = {
  json: 'Each change as JSON, signed the Standard Webhooks way (webhook-signature).',
  slack: 'A short message for a Slack channel’s incoming webhook. Discord takes it too, at its webhook address plus /slack.',
  jsonata: 'Your expression makes the body from the JSON message: the shape another system’s API takes. Nothing: not sent.',
};
export const EVENT_NAMES: Record<string, string> = { changes: 'Changes', reviews: 'Reviews' };

/** Starting points for a JSONata expression, so nobody starts from an empty box. */
export const SAMPLE_IN = '{ "flags": settings{ name: { "value": value } } }';
export const SAMPLE_OUT = 'type = "changes" ? { "settings": data.changes.{ "name": flag, "environment": environment } }';

/** The Multi-Provider set-up shown on the page: CompanyFlags first, the old system for what isn't here yet. */
export const SIDE_BY_SIDE = `import { OpenFeature, MultiProvider, FirstMatchStrategy } from '@openfeature/web-sdk';
import { OFREPWebProvider } from '@openfeature/ofrep-web-provider';

await OpenFeature.setProviderAndWait(new MultiProvider([
  { provider: new OFREPWebProvider({
      baseUrl: 'https://flags.example.com',
      headers: [['Authorization', \`Bearer \${session.flagsToken}\`]],
  }) },
  { provider: oldSystemProvider },   // every flag not in this app's flag set yet
], new FirstMatchStrategy()));`;

/** Saves text as a file in the browser's downloads. */
export function download(name: string, text: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The full address of an incoming webhook, from its token. */
export const incomingUrl = (token: string) => `${location.origin}/hooks/v1/${token}`;

/** How the last delivery went, in a few words. */
export function lastDelivery(w: WebhookOut): { text: string; tone: 'ok' | 'bad' | 'none' } {
  if (!w.enabled) return { text: 'Switched off', tone: 'none' };
  const failed = w.lastFailedAt && (!w.lastSentAt || w.lastFailedAt > w.lastSentAt);
  if (failed) return { text: w.lastError ?? 'Failed', tone: 'bad' };
  if (w.lastSentAt) return { text: `Delivered${w.lastStatus ? ` (${w.lastStatus})` : ''}`, tone: 'ok' };
  return { text: 'Nothing sent yet', tone: 'none' };
}

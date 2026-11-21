// The integrations a server runs without a config file's `plugins`, from environment variables alone, so the Docker
// image and a cloud container need no file of their own:
//
//   the defaults (defaultPlugins())       on, unless FF_INTEGRATIONS_OFF names them: FF_INTEGRATIONS_OFF=mcp,webhooks
//   metrics()                              FF_METRICS=on (FF_METRICS_TOKEN, if set, guards /metrics)
//   cloudfront()                           FF_CLOUDFRONT_DISTRIBUTION_ID
//   cloudCdn()                             FF_CLOUD_CDN_PROJECT and FF_CLOUD_CDN_URL_MAP (FF_CLOUD_CDN_HOST, if set)
//
// A config file that lists `plugins` wins entirely: these variables then switch nothing on or off (ignoredEnv says
// which were set for nothing). Users read "integrations"; "plugin" is for people writing their own.

import { ConfigError } from './config.ts';
import type { Plugin } from './plugin.ts';
import { cloudCdn, cloudfront, defaultPlugins, metrics } from './plugins/index.ts';

type Env = Readonly<Record<string, string | undefined>>;

/** What the startup log calls each built-in integration. One of your own goes by its id. */
const NAMES: Record<string, string> = {
  ofrep: 'OFREP', flagd: 'flagd', 'cdn-files': 'CDN files', cloudflare: 'Cloudflare purge', webhooks: 'webhooks', mcp: 'MCP',
  metrics: 'metrics', cloudfront: 'CloudFront purge', 'cloud-cdn': 'Cloud CDN purge',
};
/** Each optional integration, and the variable that turns it on. */
const OPTIONAL: Record<string, string> = { metrics: 'FF_METRICS=on', cloudfront: 'FF_CLOUDFRONT_DISTRIBUTION_ID', 'cloud-cdn': 'FF_CLOUD_CDN_PROJECT and FF_CLOUD_CDN_URL_MAP' };
/** Parts of the core, always on: a name someone might try to turn off. */
const CORE = new Set(['console', 'api', 'sign-in', 'auth', 'evaluator', 'history', 'journal', 'publishing', 'approvals', 'app-links', 'links']);
const CLOUD_CDN = ['FF_CLOUD_CDN_PROJECT', 'FF_CLOUD_CDN_URL_MAP', 'FF_CLOUD_CDN_HOST'];

/** The integrations on, in plain words, for the startup log: "OFREP, flagd, CDN files, …", or "none". */
export const integrationNames = (ids: readonly string[]): string => ids.map((id) => NAMES[id] ?? id).join(', ') || 'none';

const set = (env: Env, name: string) => !!env[name]?.trim();

/** The plugins from the environment: the defaults FF_INTEGRATIONS_OFF leaves on, then the optional ones whose settings
 *  are there. A name it doesn't know, a part of the core, or a setting only half there stops the start (ConfigError). */
export function integrationsFromEnv(env: Env): Plugin[] {
  const defaults = defaultPlugins();
  const known = defaults.map((p) => p.id);
  const off = new Set<string>();
  for (const raw of (env.FF_INTEGRATIONS_OFF ?? '').split(',')) {
    const id = raw.trim().toLowerCase();
    if (!id) continue;
    if (known.includes(id)) { off.add(id); continue; }
    const can = `It can turn off: ${known.join(', ')}.`;
    if (CORE.has(id)) throw new ConfigError(`FF_INTEGRATIONS_OFF: "${id}" is part of the core, which is always on. ${can}`);
    if (OPTIONAL[id]) throw new ConfigError(`FF_INTEGRATIONS_OFF: "${id}" is off already; only ${OPTIONAL[id]} turns it on. ${can}`);
    throw new ConfigError(`FF_INTEGRATIONS_OFF: no integration "${raw.trim()}". ${can}`);
  }
  const plugins = defaults.filter((p) => !off.has(p.id));

  const metricsSetting = env.FF_METRICS?.trim().toLowerCase();
  if (metricsSetting && !['on', 'off'].includes(metricsSetting)) throw new ConfigError(`FF_METRICS is on or off, not ${env.FF_METRICS}`);
  if (metricsSetting === 'on') plugins.push(metrics());
  else if (!metricsSetting && set(env, 'FF_METRICS_TOKEN')) {
    throw new ConfigError('FF_METRICS_TOKEN is set, but metrics are off: set FF_METRICS=on to serve /metrics');
  }

  if (set(env, 'FF_CLOUDFRONT_DISTRIBUTION_ID')) plugins.push(cloudfront());

  if (CLOUD_CDN.some((v) => set(env, v))) {
    const missing = CLOUD_CDN.slice(0, 2).filter((v) => !set(env, v));
    if (missing.length) {
      throw new ConfigError(`Cloud CDN purge needs FF_CLOUD_CDN_PROJECT and FF_CLOUD_CDN_URL_MAP: ${missing.join(' and ')} ${missing.length === 1 ? 'isn’t' : 'aren’t'} set`);
    }
    plugins.push(cloudCdn());
  }
  return plugins;
}

/** The integration variables set for nothing, as a config file lists `plugins`: the switches always, and an optional
 *  integration's settings when the list leaves it out (cloudfront() still reads FF_CLOUDFRONT_DISTRIBUTION_ID). */
export function ignoredEnv(env: Env, plugins: readonly Plugin[]): string[] {
  const listed = new Set(plugins.map((p) => p?.id));
  const reads: [string, string | null][] = [
    ['FF_INTEGRATIONS_OFF', null], ['FF_METRICS', null], ['FF_METRICS_TOKEN', 'metrics'],
    ['FF_CLOUDFRONT_DISTRIBUTION_ID', 'cloudfront'], ...CLOUD_CDN.map((v): [string, string] => [v, 'cloud-cdn']),
  ];
  return reads.filter(([v, by]) => set(env, v) && !(by && listed.has(by))).map(([v]) => v);
}

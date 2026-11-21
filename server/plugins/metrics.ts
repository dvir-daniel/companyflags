// The metrics plugin: Prometheus's text format at /metrics, for an operator's Prometheus, Grafana Agent or
// OpenTelemetry Collector to scrape. Off unless FF_METRICS=on (without a list of plugins), or listed:
//
//   plugins: [...defaultPlugins(), metrics()]          // or metrics({ token: process.env.METRICS_TOKEN })
//
// What it counts, in this server process (each process has its own; scrape every one):
//   companyflags_http_requests_total{method,route,status}        every request, by its route as written (no secrets)
//   companyflags_http_request_duration_seconds{route}            how long each took to answer (a histogram)
//   companyflags_flag_requests_total{protocol,status}            apps' and backends' reads: OFREP, CDN files, flagd
//   companyflags_event_streams{route}                            live-update streams open now (OFREP's, the console's)
//   companyflags_publish_lag_seconds{environment}                how long the oldest publish has waited (0: none)
//   companyflags_publish_failing{environment}                    1 while an environment's snapshot can't be built
//   companyflags_purge_failing{environment}                      1 while its last CDN purge hasn't gone through
//   companyflags_warnings                                        how many warnings /readyz lists (it still answers 200)
//   companyflags_revision{environment}, companyflags_serving_revision{environment}
//   companyflags_info{version}

import { timingSafeEqual, createHash } from 'node:crypto';
import type { Context } from 'hono';
import { routePath } from 'hono/route';
import { definePlugin, pluginRoutes } from '../plugin.ts';
import { VERSION } from '../packageFolder.ts';

export type MetricsOptions = {
  /** A scraper sends it as `Authorization: Bearer <token>`. Default: FF_METRICS_TOKEN; with neither, /metrics is
   *  open to whoever reaches the server, so keep it on your own network. */
  token?: string;
};

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/** A label's value, as the text format writes it. */
const label = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const labels = (l: Record<string, string>) => `{${Object.entries(l).map(([k, v]) => `${k}="${label(v)}"`).join(',')}}`;

/** Which way of reading flags a route is, if it is one. */
function protocolOf(route: string): string | null {
  if (route.startsWith('/ofrep/v1/evaluate/flags/')) return 'ofrep';
  if (route === '/ofrep/v1/evaluate/flags') return 'ofrep_bulk';
  if (route.startsWith('/cdn/v1/flags')) return 'cdn';
  if (route.startsWith('/sdk/v1/flagd')) return 'flagd';
  return null;
}

export const metrics = (o: MetricsOptions = {}) => definePlugin({
  id: 'metrics',
  setup: ({ env, publishState, warnings }) => {
    const token = o.token ?? (env.FF_METRICS_TOKEN || undefined);
    const requests = new Map<string, { labels: Record<string, string>; n: number }>();
    const flagReads = new Map<string, { labels: Record<string, string>; n: number }>();
    const durations = new Map<string, { counts: number[]; sum: number; n: number }>();
    const streams = new Map<string, number>();
    const add = (m: Map<string, { labels: Record<string, string>; n: number }>, l: Record<string, string>) => {
      const k = JSON.stringify(l);
      const cur = m.get(k);
      if (cur) cur.n++; else m.set(k, { labels: l, n: 1 });
    };
    const routeOf = (c: Context) => {
      try { return routePath(c) || 'unmatched'; } catch { return 'unmatched'; }
    };

    const routes = pluginRoutes();
    routes.get('/metrics', async (c) => {
      if (token) {
        const sent = c.req.header('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? '';
        const h = (s: string) => createHash('sha256').update(s).digest();
        if (!timingSafeEqual(h(sent), h(token))) return c.json({ error: 'send the metrics token: Authorization: Bearer <token>', code: 'unauthorized' }, 401);
      }
      const out: string[] = [];
      const family = (name: string, type: string, help: string) => out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
      family('companyflags_info', 'gauge', 'The version this server runs.');
      out.push(`companyflags_info${labels({ version: VERSION })} 1`);
      family('companyflags_http_requests_total', 'counter', 'Requests answered, by method, route and status.');
      for (const r of requests.values()) out.push(`companyflags_http_requests_total${labels(r.labels)} ${r.n}`);
      family('companyflags_http_request_duration_seconds', 'histogram', 'How long requests took to answer, by route.');
      for (const [route, d] of durations) {
        BUCKETS.forEach((le, i) => out.push(`companyflags_http_request_duration_seconds_bucket${labels({ route, le: String(le) })} ${d.counts[i]}`));
        out.push(`companyflags_http_request_duration_seconds_bucket${labels({ route, le: '+Inf' })} ${d.n}`);
        out.push(`companyflags_http_request_duration_seconds_sum${labels({ route })} ${d.sum.toFixed(6)}`);
        out.push(`companyflags_http_request_duration_seconds_count${labels({ route })} ${d.n}`);
      }
      family('companyflags_flag_requests_total', 'counter', 'Apps’ and backends’ requests for flags (OFREP, CDN files, flagd), by status.');
      for (const r of flagReads.values()) out.push(`companyflags_flag_requests_total${labels(r.labels)} ${r.n}`);
      family('companyflags_event_streams', 'gauge', 'Live-update streams open now.');
      for (const [route, n] of streams) out.push(`companyflags_event_streams${labels({ route })} ${n}`);
      try {
        const state = await publishState();
        family('companyflags_publish_lag_seconds', 'gauge', 'How long the oldest publish still waiting has waited (0: none waits).');
        for (const s of state) out.push(`companyflags_publish_lag_seconds${labels({ environment: s.environment })} ${s.lagSeconds}`);
        family('companyflags_publish_failing', 'gauge', '1 while an environment’s new snapshot can’t be built (it serves the one before).');
        for (const s of state) out.push(`companyflags_publish_failing${labels({ environment: s.environment })} ${s.error ? 1 : 0}`);
        family('companyflags_purge_failing', 'gauge', '1 while the CDN purge after an environment’s last publish hasn’t gone through (apps reading CDN files wait for the CDN’s minute).');
        for (const s of state) out.push(`companyflags_purge_failing${labels({ environment: s.environment })} ${s.purgeError ? 1 : 0}`);
        family('companyflags_warnings', 'gauge', 'How many warnings /readyz lists: what needs a look though the server serves.');
        out.push(`companyflags_warnings ${(await warnings()).length}`);
        family('companyflags_revision', 'gauge', 'The environment’s newest version, in the database.');
        for (const s of state) out.push(`companyflags_revision${labels({ environment: s.environment })} ${s.revision}`);
        family('companyflags_serving_revision', 'gauge', 'The version this server process serves.');
        for (const s of state) if (s.serving !== null) out.push(`companyflags_serving_revision${labels({ environment: s.environment })} ${s.serving}`);
        family('companyflags_database_up', 'gauge', '1 while the database answers.');
        out.push('companyflags_database_up 1');
      } catch {
        family('companyflags_database_up', 'gauge', '1 while the database answers.');
        out.push('companyflags_database_up 0');
      }
      c.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
      c.header('Cache-Control', 'no-store');
      return c.body(`${out.join('\n')}\n`);
    });

    return {
      routes,
      prefixes: ['/metrics'],
      middleware: async (c, next) => {
        const t0 = performance.now();
        await next();
        const seconds = (performance.now() - t0) / 1000;
        const route = routeOf(c);
        const status = String(c.res.status);
        add(requests, { method: c.req.method, route, status });
        const protocol = protocolOf(route);
        if (protocol) add(flagReads, { protocol, status });
        let d = durations.get(route);
        if (!d) durations.set(route, (d = { counts: BUCKETS.map(() => 0), sum: 0, n: 0 }));
        BUCKETS.forEach((le, i) => { if (seconds <= le) d.counts[i]++; });
        d.sum += seconds;
        d.n++;
        // a live-update stream is open until its body ends or the client goes: counted while it is
        const body = c.res.body;
        if (body && c.res.headers.get('content-type')?.startsWith('text/event-stream')) {
          streams.set(route, (streams.get(route) ?? 0) + 1);
          let open = true;
          const close = () => { if (open) { open = false; streams.set(route, (streams.get(route) ?? 1) - 1); } };
          const reader = body.getReader();
          const counted = new ReadableStream<Uint8Array>({
            async pull(ctl) {
              try {
                const { done, value } = await reader.read();
                if (done) { close(); ctl.close(); } else ctl.enqueue(value);
              } catch (e) { close(); ctl.error(e); }
            },
            async cancel(reason) { close(); await reader.cancel(reason); },
          });
          c.res = new Response(counted, { status: c.res.status, statusText: c.res.statusText, headers: c.res.headers });
        }
      },
    };
  },
});

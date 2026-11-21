// The Cloudflare plugin: after each publish, drops the CDN files it changed from Cloudflare's cache (../cdn.ts), so
// apps get a change in seconds instead of within a minute. The zone and a token that may purge it are set here,
// else with CF_ZONE_ID and CF_API_TOKEN, else by an admin in the console (Settings → CDN, its console routes below).

import { consoleRoutes, definePlugin } from '../plugin.ts';
import { createCdn } from '../cdn.ts';

export type CloudflareOptions = {
  /** The zone the CDN files are served through, and an API token with Zone → Cache Purge → Purge on it. Each one
   *  left out comes from CF_ZONE_ID or CF_API_TOKEN. With both, they win over the console's; with neither, an admin
   *  sets them in the console. */
  zoneId?: string;
  token?: string;
  /** How the server reaches Cloudflare: fetch, unless a test hands it another. Without one, nothing is purged. */
  fetch?: typeof fetch;
};

export const cloudflare = (o: CloudflareOptions = {}) => definePlugin({
  id: 'cloudflare',
  setup: async ({ db, env, log, secrets }) => {
    const server = { zoneId: o.zoneId ?? (env.CF_ZONE_ID || undefined), token: o.token ?? (env.CF_API_TOKEN || undefined) };
    const cdn = createCdn(db, { fetch: 'fetch' in o ? o.fetch : globalThis.fetch, server, log, secrets });
    await cdn.lookAgain();
    return {
      onPublish: cdn.purge,
      // while a zone and token are set: CDN files let the CDN keep an old copy longer during an outage (plugin.ts)
      purges: cdn.purges,
      warnings: cdn.warnings,
      // admins set the zone and token; everyone can see whether it's set up (never the token) and how the last
      // publishes' purges went
      console: ({ actor, adminOnly, body }) => {
        const app = consoleRoutes();
        app.get('/cdn', async (c) => c.json(await cdn.state()));
        app.put('/cdn', async (c) => {
          adminOnly(c.get('user'));
          await cdn.save(await body(c), actor(c.get('user')));
          return c.json(await cdn.state());
        });
        app.delete('/cdn', async (c) => {
          adminOnly(c.get('user'));
          await cdn.remove(actor(c.get('user')));
          return c.json(await cdn.state());
        });
        app.post('/cdn/purge', async (c) => {
          adminOnly(c.get('user'));
          const { environment } = await body<{ environment?: unknown }>(c);
          await cdn.purgeNow(environment, actor(c.get('user')));
          return c.json({ purged: true });
        });
        return app;
      },
    };
  },
});

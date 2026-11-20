// The webhooks plugin (../webhooks.ts): webhooks out, sent after each change (signed JSON, Slack, or JSONata's shape),
// and webhooks in, where another system posts its values to be imported. Admins set both up on the console's
// Migration page.
//   POST /hooks/v1/<token>   a webhook in's address (shown once in the console)

import { Hono } from 'hono';
import { consoleRoutes, definePlugin } from '../plugin.ts';
import { createWebhooks } from '../webhooks.ts';

export type WebhooksOptions = {
  /** How the server sends them: fetch, unless a test hands it another. Without one, nothing is sent. */
  fetch?: typeof fetch;
  /** tests: how long a hole in the history is waited for, and how often it looks for changes */
  gapWaitMs?: number;
  everyMs?: number;
};

const BODY_MAX = 1_000_000;

export const webhooks = (o: WebhooksOptions = {}) => definePlugin({
  id: 'webhooks',
  setup: ({ db, plane, baseURL, log }) => {
    const hooks = createWebhooks(db, plane, {
      fetch: 'fetch' in o ? o.fetch : globalThis.fetch, gapWaitMs: o.gapWaitMs, everyMs: o.everyMs, baseURL, log,
    });

    // webhooks in: another system posts its values here
    const routes = new Hono();
    routes.post('/hooks/v1/:token', async (c) => {
      if (Number(c.req.header('content-length') ?? 0) > BODY_MAX) return c.json({ error: 'The body is larger than 1 MB.' }, 413);
      const r = await hooks.receive(c.req.param('token'), await c.req.text());
      return c.json(r.json, r.status as 200);
    });

    return {
      routes,
      prefixes: ['/hooks'],
      worker: hooks.start(),
      // everyone can see them (never an address, a header or a secret); only admins change them
      console: ({ actor, adminOnly }) => {
        const app = consoleRoutes();
        app.get('/webhooks', async (c) => c.json(await hooks.list()));
        app.post('/webhooks', async (c) => {
          adminOnly(c.get('user'));
          return c.json(await hooks.add(await c.req.json(), actor(c.get('user'))), 201);
        });
        app.put('/webhooks/:id{[0-9]+}', async (c) => {
          adminOnly(c.get('user'));
          return c.json(await hooks.update(c.req.param('id'), await c.req.json(), actor(c.get('user'))));
        });
        app.delete('/webhooks/:id{[0-9]+}', async (c) => {
          adminOnly(c.get('user'));
          await hooks.remove(c.req.param('id'), actor(c.get('user')));
          return c.json({ removed: true });
        });
        app.post('/webhooks/:id{[0-9]+}/test', async (c) => {
          adminOnly(c.get('user'));
          return c.json(await hooks.test(c.req.param('id')));
        });
        app.post('/webhooks/:id{[0-9]+}/secret', async (c) => {
          adminOnly(c.get('user'));
          return c.json(await hooks.newSecret(c.req.param('id'), actor(c.get('user'))));
        });
        app.post('/webhooks/in', async (c) => {
          adminOnly(c.get('user'));
          return c.json(await hooks.addIn(await c.req.json(), actor(c.get('user'))), 201);
        });
        app.put('/webhooks/in/:id{[0-9]+}', async (c) => {
          adminOnly(c.get('user'));
          return c.json(await hooks.updateIn(c.req.param('id'), await c.req.json(), actor(c.get('user'))));
        });
        app.delete('/webhooks/in/:id{[0-9]+}', async (c) => {
          adminOnly(c.get('user'));
          await hooks.removeIn(c.req.param('id'), actor(c.get('user')));
          return c.json({ removed: true });
        });
        app.post('/webhooks/in/:id{[0-9]+}/token', async (c) => {
          adminOnly(c.get('user'));
          return c.json(await hooks.newToken(c.req.param('id'), actor(c.get('user'))));
        });
        return app;
      },
    };
  },
});

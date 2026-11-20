// The webhooks plugin (../webhooks.ts): webhooks out, sent after each change (signed JSON, Slack, or JSONata's shape),
// and webhooks in, where another system posts its values to be imported. Admins set both up on the console's
// Migration page.
//   POST /hooks/v1/<token>   a webhook in's address (shown once in the console)

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { consoleRoutes, definePlugin } from '../plugin.ts';
import { allowedOriginsFrom, publicFetch } from '../publicFetch.ts';
import { BODY_MAX, BODY_TOO_LARGE, createWebhooks } from '../webhooks.ts';

export type WebhooksOptions = {
  /** How the server sends them: to public addresses only (publicFetch), unless a test hands it another fetch. With
   *  `fetch: undefined`, nothing is sent. */
  fetch?: typeof fetch;
  /** Origins on your own network that webhooks may reach, e.g. http://ci.internal:8080. Default:
   *  FF_WEBHOOK_ALLOWED_ORIGINS, comma-separated. */
  allowedOrigins?: string[];
  /** tests: how long a hole in the history is waited for, and how often it looks for changes */
  gapWaitMs?: number;
  everyMs?: number;
};

export const webhooks = (o: WebhooksOptions = {}) => definePlugin({
  id: 'webhooks',
  setup: ({ db, plane, baseURL, log, secrets }) => {
    const allowedOrigins = o.allowedOrigins ?? allowedOriginsFrom(process.env.FF_WEBHOOK_ALLOWED_ORIGINS);
    const hooks = createWebhooks(db, plane, {
      fetch: 'fetch' in o ? o.fetch : publicFetch({ allowedOrigins }), gapWaitMs: o.gapWaitMs, everyMs: o.everyMs, baseURL, log, secrets,
    });

    // webhooks in: another system posts its values here. The size is checked as the body arrives (a body sent in chunks
    // has no Content-Length), and the body is read only once the address is known to be a webhook's.
    const routes = new Hono();
    const limit = bodyLimit({ maxSize: BODY_MAX, onError: (c) => c.json({ error: BODY_TOO_LARGE }, 413) });
    routes.post('/hooks/v1/:token', limit, async (c) => {
      const r = await hooks.receive(c.req.param('token'), () => c.req.text());
      return c.json(r.json, r.status as 200);
    });

    return {
      routes,
      prefixes: ['/hooks'],
      worker: hooks.start(),
      // everyone can see them (never an address, a header or a secret); only admins change them
      console: ({ actor, adminOnly, body }) => {
        const app = consoleRoutes();
        app.get('/webhooks', async (c) => c.json(await hooks.list()));
        app.post('/webhooks', async (c) => {
          adminOnly(c.get('user'));
          return c.json(await hooks.add(await body(c), actor(c.get('user'))), 201);
        });
        app.put('/webhooks/:id{[0-9]+}', async (c) => {
          adminOnly(c.get('user'));
          return c.json(await hooks.update(c.req.param('id'), await body(c), actor(c.get('user'))));
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
          return c.json(await hooks.addIn(await body(c), actor(c.get('user'))), 201);
        });
        app.put('/webhooks/in/:id{[0-9]+}', async (c) => {
          adminOnly(c.get('user'));
          return c.json(await hooks.updateIn(c.req.param('id'), await body(c), actor(c.get('user'))));
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

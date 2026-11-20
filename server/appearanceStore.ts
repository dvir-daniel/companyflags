// Settings → Appearance, kept (appearance.ts has the checks, colors and CSS). An admin changes it in the console;
// a config file's `appearance` wins and can't be changed there (`source: 'server'`), as the CDN's server settings do.
//
//   GET    /api/appearance            anyone, signed in or not: the sign-in page shows the name, logo and note
//   GET    /api/appearance/images/:image    the logo, the logo for dark, or the icon (?v= its hash: cached for good)
//   PUT    /api/appearance            admins (in api.ts, signed in)
//   DELETE /api/appearance            admins: back to CompanyFlags's own look
//
// The images are served with a policy that runs nothing, so an SVG opened on its own can't run a script here.

import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { HttpError, one, type Db } from './db.ts';
import * as journal from './journal.ts';
import type { Actor } from './layers.ts';
import { AppearanceError, checkAppearance, EMPTY, imageOf, intoPage, LIMITS, type Appearance, type Images, type PublicAppearance } from './appearance.ts';

const IMAGES = { logo: 'logo', 'logo-dark': 'logoDark', icon: 'icon' } as const satisfies Record<string, keyof Images>;
// how long another server on the same database may show the old settings
const FRESH_MS = 15_000;

const hashOf = (s: string) => createHash('sha256').update(s).digest('base64url').slice(0, 12);

export type AppearanceState = PublicAppearance & { banner: Appearance['banner']; updatedAt: string | null; updatedBy: string | null };

export function createAppearance(db: Db, fromConfig?: unknown) {
  // the config file's settings, checked once at start: a mistake there stops the server with the reason
  let server: Appearance | null = null;
  if (fromConfig !== undefined && fromConfig !== null) {
    try { server = checkAppearance(fromConfig); }
    catch (e) { throw new AppearanceError(`appearance in companyflags.config.ts: ${(e as Error).message}`); }
  }
  let cached: { at: number; row: { settings: Appearance; updatedAt: string | null; updatedBy: string | null } } | null = null;
  const read = async () => {
    if (server) return { settings: server, updatedAt: null, updatedBy: null };
    if (cached && Date.now() - cached.at < FRESH_MS) return cached.row;
    const r = await one<{ settings: Appearance; updatedAt: string; updatedBy: string }>(db,
      `select settings, updated_at as "updatedAt", updated_by as "updatedBy" from appearance`);
    const row = r ? { settings: r.settings, updatedAt: String(r.updatedAt), updatedBy: r.updatedBy } : { settings: EMPTY, updatedAt: null, updatedBy: null };
    cached = { at: Date.now(), row };
    return row;
  };
  const imageUrl = (a: Appearance, which: keyof typeof IMAGES) => {
    const v = a[IMAGES[which]];
    return v ? `/api/appearance/images/${which}?v=${hashOf(v)}` : null;
  };
  const toPublic = (a: Appearance): PublicAppearance => {
    const { banner: _, ...rest } = a;
    return { ...rest, logo: imageUrl(a, 'logo'), logoDark: imageUrl(a, 'logo-dark'), icon: imageUrl(a, 'icon'), source: server ? 'server' : 'console' };
  };
  const fromServer = () => new HttpError(409, 'The appearance is set in companyflags.config.ts on the server: change it there.');
  const state = async (): Promise<AppearanceState> => {
    const { settings, updatedAt, updatedBy } = await read();
    return { ...toPublic(settings), banner: settings.banner, updatedAt, updatedBy };
  };

  return {
    /** What everyone sees, and the notice for people signed in. */
    state,
    /** The settings with the images themselves, for the admin's form. */
    async settings(): Promise<Appearance> { return (await read()).settings; },

    async save(input: unknown, actor: Actor): Promise<void> {
      if (server) throw fromServer();
      let next: Appearance;
      try { next = checkAppearance(input); } catch (e) { throw new HttpError(422, (e as Error).message); }
      const before = (await read()).settings;
      await db.transaction(async (tx) => {
        await tx.query(`insert into appearance (id, settings, updated_at, updated_by) values (true, $1, now(), $2)
          on conflict (id) do update set settings = excluded.settings, updated_at = now(), updated_by = excluded.updated_by`, [JSON.stringify(next), actor.name]);
        await journal.audit(tx, actor, { kind: 'appearance.update', before: forHistory(before), after: forHistory(next) });
      });
      cached = null;
    },

    async reset(actor: Actor): Promise<void> {
      if (server) throw fromServer();
      await db.transaction(async (tx) => {
        const gone = await one<{ settings: Appearance }>(tx, `delete from appearance returning settings`);
        if (gone) await journal.audit(tx, actor, { kind: 'appearance.reset', before: forHistory(gone.settings) });
      });
      cached = null;
    },

    /** The console's page with the name, icon, colors and default look in it. */
    async page(html: string): Promise<string> {
      try { return intoPage(html, toPublic((await read()).settings)); }
      catch { return html; }                       // the database not answering yet: the page as built
    },

    /** GET /api/appearance and the images: open to everyone, before the sign-in. */
    routes(): Hono {
      const app = new Hono();
      app.get('/appearance', async (c) => {
        const { banner: _, updatedAt: __, updatedBy: ___, ...open } = await state();
        c.header('Cache-Control', 'no-cache');
        return c.json(open);
      });
      app.get('/appearance/images/:image', async (c) => {
        const which = c.req.param('image');
        if (!(which in IMAGES)) return c.json({ error: `no such image: ${which} (logo, logo-dark or icon)`, code: 'not_found' }, 404);
        const v = (await read()).settings[IMAGES[which as keyof typeof IMAGES]];
        if (!v) return c.json({ error: `no ${which} is set`, code: 'not_found' }, 404);
        const { type } = imageOf(v, Math.max(LIMITS.image, LIMITS.icon));
        const body = Buffer.from(v.slice(v.indexOf(',') + 1), 'base64');
        c.header('Content-Type', type);
        c.header('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; sandbox`);
        c.header('Cache-Control', c.req.query('v') === hashOf(v) ? 'public, max-age=31536000, immutable' : 'no-cache');
        return c.body(body);
      });
      return app;
    },
  };
}
export type AppearanceStore = ReturnType<typeof createAppearance>;

/** History keeps the words and colors, and only whether each image is set (an image's short hash, not the image). */
function forHistory(a: Appearance) {
  const img = (v: string | null) => (v ? `image ${hashOf(v)}` : null);
  return { ...a, logo: img(a.logo), logoDark: img(a.logoDark), icon: img(a.icon) };
}

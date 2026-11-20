// Settings → Appearance (server/appearance.ts, appearanceStore.ts): an admin sets the console's name, logo, icon,
// accent, default look, notice, sign-in note and links; everyone, signed in or not, gets what the sign-in page needs;
// the notice is for people signed in; images are served from this server with a policy that runs nothing; the page
// the server sends already has the name, icon and colors. A config file's appearance wins and can't be changed.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.ts';
import { ACCENTS, accentColors, accentCss, AppearanceError, checkAppearance, contrast, inkOn, intoPage, knownAccent, lowContrast, nearMeaning, PAGE as PAGES, readableOn } from '../server/appearance.ts';
import { createAppearance } from '../server/appearanceStore.ts';

const SVG = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>').toString('base64')}`;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PAGE = '<!doctype html><html lang="en"><head><title>CompanyFlags</title><link rel="icon" href="data:image/svg+xml,x" /></head><body></body></html>';

let t: Awaited<ReturnType<typeof boot>>;
before(async () => { t = await boot(); });
after(async () => { await t.stop(); });

const open = async (path: string) => {
  const r = await t.app.request(path);
  return { status: r.status, headers: r.headers, body: Buffer.from(await r.arrayBuffer()) };
};
const openJson = async (path: string) => JSON.parse((await open(path)).body.toString());

test('nothing set: the default look, open to everyone before the sign-in', async () => {
  const a = await openJson('/api/appearance');
  assert.deepEqual([a.name, a.logo, a.icon, a.accent, a.mode, a.source], [null, null, null, 'none', 'device', 'console']);
  assert.equal('banner' in a, false, 'the notice is for people signed in');
  assert.equal((await t.as('alice').get('/meta')).json.banner, null);
});

test('only admins change it, and what they send is checked', async () => {
  assert.equal((await t.as('alice').put('/appearance', { name: 'Acme Flags' })).status, 403);
  const bad = async (body: unknown, says: RegExp) => {
    const r = await t.as('dana').put('/appearance', body);
    assert.equal(r.status, 422, JSON.stringify(r.json));
    assert.match(r.json.error, says);
  };
  await bad({ helpUrl: 'javascript:alert(1)' }, /must start with https/);
  await bad({ links: [{ label: 'Privacy', url: 'data:text/html,hi' }] }, /footer link 1 must start with https/);
  await bad({ links: [{ label: '', url: 'https://acme.example/privacy' }] }, /needs a label/);
  await bad({ logo: 'data:text/html;base64,PHNjcmlwdD4=' }, /isn’t an image/);
  await bad({ logo: 'https://acme.example/logo.png' }, /PNG, SVG/);
  await bad({ icon: `data:image/png;base64,${'A'.repeat(80_000)}` }, /at most 50 KB/);
  await bad({ accent: 'custom' }, /choose the color/);
  await bad({ accent: 'custom', accentColor: 'red' }, /hex color/);
  await bad({ accent: 'plaid' }, /accent is one of/);
  await bad({ name: 'x'.repeat(41) }, /at most 40/);
  await bad({ banner: { text: 'Freeze', tone: 'loud' } }, /tone/);
});

test('saved: the sign-in page, the console, the images and History', async () => {
  const r = await t.as('dana').put('/appearance', {
    name: '  Acme‮ Flags ', logo: SVG, icon: PNG, accent: 'custom', accentColor: '#2563EB', mode: 'dark',
    banner: { text: 'Release freeze until Monday.', tone: 'warn' }, signInNote: 'For Acme Corp staff.',
    helpUrl: 'mailto:flags@acme.example', links: [{ label: 'Privacy', url: 'https://acme.example/privacy' }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const a = await openJson('/api/appearance');
  assert.equal(a.name, 'Acme Flags', 'trimmed, without the character that turns text around');
  assert.equal(a.accentColor, '#2563eb');
  assert.match(a.logo, /^\/api\/appearance\/images\/logo\?v=[\w-]{12}$/);
  assert.equal(a.logoDark, null);
  assert.equal('banner' in a, false);
  assert.deepEqual((await t.as('alice').get('/meta')).json.banner, { text: 'Release freeze until Monday.', tone: 'warn' });

  // the image itself: its type, cached for good at its hash, and nothing in it runs (an SVG opened on its own)
  const img = await open(a.logo);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/svg+xml');
  assert.match(img.headers.get('content-security-policy')!, /default-src 'none'.*sandbox/);
  assert.match(img.headers.get('cache-control')!, /immutable/);
  assert.match(img.body.toString(), /<svg/);
  assert.match((await open('/api/appearance/images/logo?v=old')).headers.get('cache-control')!, /no-cache/);
  assert.equal((await open('/api/appearance/images/logo-dark')).status, 404);
  assert.equal((await open('/api/appearance/images/secrets')).status, 404);

  // the admin's form gets the images themselves; everyone may look, as at the rest of Settings
  const form = (await t.as('alice').get('/appearance/settings')).json;
  assert.equal(form.logo, SVG);
  assert.equal(form.updatedBy, 'dana');

  const h = (await t.as('dana').get('/history?type=appearance')).json[0];
  assert.equal(h.changeType, 'appearance.update');
  assert.match(h.after.logo, /^image [\w-]{12}$/, 'History has a hash, not the image');
  assert.equal(h.after.name, 'Acme Flags');
});

test('back to the default', async () => {
  assert.equal((await t.as('alice').del('/appearance')).status, 403);
  assert.equal((await t.as('dana').del('/appearance')).status, 200);
  const a = await openJson('/api/appearance');
  assert.deepEqual([a.name, a.logo, a.accent], [null, null, 'none']);
  assert.equal((await t.as('dana').get('/history?type=appearance')).json[0].changeType, 'appearance.reset');
});

test('set in the config file: shown, and not changed in the console', async () => {
  const s = await boot({ appearance: { name: 'Globex Flags', accent: 'teal', mode: 'light' } });
  try {
    const a = JSON.parse(await (await s.app.request('/api/appearance')).text());
    assert.deepEqual([a.name, a.accent, a.source], ['Globex Flags', 'teal', 'server']);
    const r = await s.as('dana').put('/appearance', { name: 'Other' });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /companyflags\.config\.ts/);
  } finally { await s.stop(); }
  // a mistake in the file stops the server with the reason
  assert.throws(() => createAppearance(t.db, { helpUrl: 'ftp://x' }), (e: Error) => e instanceof AppearanceError && /config\.ts: the help link/.test(e.message));
});

test('the page the server sends has the name, icon, colors and default look', () => {
  const html = intoPage(PAGE, { name: 'Acme <Flags>', icon: '/api/appearance/images/icon?v=abc', accent: 'blue', accentColor: null, mode: 'dark' });
  assert.match(html, /<title>Acme &#60;Flags&#62;<\/title>/, 'the name is escaped');
  assert.match(html, /<link rel="icon" href="\/api\/appearance\/images\/icon\?v=abc"/);
  assert.match(html, /<html data-mode="dark" lang="en">/);
  assert.match(html, /<style id="appearance">html\[data-theme="light"\]\{--tint:#2563eb;--tint-ink:#ffffff;/);
  assert.equal(intoPage(PAGE, { name: null, icon: null, accent: 'none', accentColor: null, mode: 'device' }), PAGE, 'nothing set: as built');
});

test('colors: text on the accent reads, and a pale accent is flagged', () => {
  assert.equal(inkOn('#2563eb'), '#ffffff');
  assert.equal(inkOn('#facc15'), '#000000');
  assert.ok(contrast('#000000', '#ffffff') > 20);
  assert.deepEqual(lowContrast({ accent: 'custom', accentColor: '#fde047' }), ['light']);
  assert.deepEqual(lowContrast({ accent: 'custom', accentColor: '#1e1b4b' }), ['dark']);
  // our own accents read as text on both pages (4.5:1), and none of them is a meaning color
  for (const accent of Object.keys(ACCENTS) as (keyof typeof ACCENTS)[]) {
    const c = accentColors({ accent, accentColor: null });
    if (!c) continue;
    assert.ok(contrast(c.light, PAGES.light) >= 4.5 && contrast(c.dark, PAGES.dark) >= 4.5, `${accent} reads on both pages`);
    assert.equal(nearMeaning(c.light), null, `${accent} isn't a meaning color`);
  }
  for (const meaning of ['#7c3aed', '#15803d', '#be123c', '#dc2626', '#b45309']) assert.ok(nearMeaning(meaning), `${meaning} is a meaning color`);
  assert.equal(accentCss({ accent: 'none', accentColor: null }), '');
  assert.equal(checkAppearance({}).accent, 'none');
});

test('colors: an accent of your own reads in each theme, and retired accents still load', () => {
  // a dark navy is lightened on black, a pale yellow darkened on white, just enough for 4.5:1
  const navy = accentColors({ accent: 'custom', accentColor: '#1e1b4b' })!;
  assert.equal(navy.light, '#1e1b4b', 'as it is where it reads');
  assert.ok(contrast(navy.dark, PAGES.dark) >= 4.5 && navy.dark !== '#1e1b4b');
  const yellow = accentColors({ accent: 'custom', accentColor: '#fde047' })!;
  assert.ok(contrast(yellow.light, PAGES.light) >= 4.5);
  assert.equal(readableOn('#2563eb', 'light'), '#2563eb');
  // violet, green, orange and rose were meaning colors: a saved one becomes the nearest we offer
  assert.equal(checkAppearance({ accent: 'violet' }).accent, 'indigo');
  assert.equal(checkAppearance({ accent: 'rose' }).accent, 'none');
  assert.equal(knownAccent('green'), 'teal');
  assert.deepEqual(accentColors({ accent: 'violet' as never, accentColor: null }), accentColors({ accent: 'indigo', accentColor: null }));
});

test('a config file names its images as files beside it', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { resolveConfig } = await import('../server/configFile.ts');
  const dir = mkdtempSync(join(tmpdir(), 'cf-look-'));
  writeFileSync(join(dir, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const r = resolveConfig({ appearance: { name: 'Acme Flags', logo: './logo.svg' } }, {}, dir);
  assert.match(r.appearance!.logo!, /^data:image\/svg\+xml;base64,/);
  assert.equal(resolveConfig({}, {}, dir).appearance, null);
  assert.throws(() => resolveConfig({ appearance: { logo: './missing.png' } }, {}, dir), /no file/);
  assert.throws(() => resolveConfig({ appearance: { logo: './logo.txt' } }, {}, dir), /isn’t an image file/);
});

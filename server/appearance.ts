// How the console looks for one installation (Settings → Appearance): its name, logo and icon, an accent color, the
// default light or dark, a notice across the top, a note on the sign-in page, a help link and links in the footer.
//
// Pure code with no server imports: the console (web/src/appearanceKit.ts) uses the same checks, colors and CSS.
// The server keeps the settings (appearanceStore.ts), puts the name, icon and colors into the console's page before
// it's sent (`intoPage`), so the first paint is already right, and serves the images from its own address.

export const DEFAULT_NAME = 'CompanyFlags';

/** The accent colors: none (black and white), a few of our own, or one of the installation's own (`custom`). Each has
 *  a shade for light and one for dark, both at 4.5:1 or more on that page color, so text drawn in it reads. None is
 *  red, green, amber or purple: those colors mean production and danger, on, waiting and agents (DESIGN.md). */
export const ACCENTS = {
  none: { label: 'None (black and white)', light: null, dark: null },
  blue: { label: 'Blue', light: '#2563eb', dark: '#60a5fa' },
  indigo: { label: 'Indigo', light: '#4f46e5', dark: '#818cf8' },
  teal: { label: 'Teal', light: '#0f766e', dark: '#2dd4bf' },
  custom: { label: 'Your own', light: null, dark: null },
} as const satisfies Record<string, { label: string; light: string | null; dark: string | null }>;
export type Accent = keyof typeof ACCENTS;
/** Accents we no longer offer, because they were meaning colors, and what a saved one becomes. */
export const RETIRED_ACCENTS: Record<string, Accent> = { violet: 'indigo', green: 'teal', orange: 'none', rose: 'none' };
/** An accent as saved (perhaps a retired one) as one we offer. */
export const knownAccent = (a: string): Accent => (a in ACCENTS ? a as Accent : RETIRED_ACCENTS[a] ?? 'none');

export const MODES = { device: 'As the device is set', light: 'Light', dark: 'Dark' } as const;
export type Mode = keyof typeof MODES;

export const TONES = { info: 'Information', warn: 'Warning', danger: 'Important' } as const;
export type Tone = keyof typeof TONES;

export type Link = { label: string; url: string };
export type Images = { logo: string | null; logoDark: string | null; icon: string | null };

/** What an admin sets. Images are data URLs (`data:image/png;base64,…`), kept in the database. */
export type Appearance = Images & {
  name: string | null;            // the console's name: the title bar, the browser tab, the sign-in page
  accent: Accent;
  accentColor: string | null;     // #rrggbb, for `custom`
  mode: Mode;                     // for people who haven't chosen light or dark themselves
  banner: { text: string; tone: Tone } | null;   // a notice at the top of every page, for people signed in
  signInNote: string | null;      // under the sign-in form ("For Acme Corp staff. Use is logged.")
  helpUrl: string | null;         // "Get help": the sign-in page and the person menu
  links: Link[];                  // in the footer: privacy, terms, the internal wiki
};

export const EMPTY: Appearance = {
  name: null, logo: null, logoDark: null, icon: null, accent: 'none', accentColor: null, mode: 'device',
  banner: null, signInNote: null, helpUrl: null, links: [],
};

/** What anyone may see, signed in or not (GET /api/appearance): the images as addresses on this server. The banner
 *  is for people signed in only (it's in /api/meta). */
export type PublicAppearance = Omit<Appearance, 'banner' | keyof Images> & Images & { source: Source };
/** Where the settings come from: the console, or the config file (then they can't be changed in the console). */
export type Source = 'console' | 'server';

export const LIMITS = { name: 40, banner: 240, signInNote: 400, linkLabel: 30, url: 500, links: 4, image: 200 * 1024, icon: 50 * 1024 };
export const IMAGE_TYPES = ['image/png', 'image/svg+xml', 'image/webp', 'image/jpeg', 'image/gif', 'image/x-icon', 'image/vnd.microsoft.icon'] as const;

export class AppearanceError extends Error {}

const HEX = /^#[0-9a-f]{6}$/;
// anything that isn't text: control characters, and the bidirectional overrides that make text read backwards
// eslint-disable-next-line no-control-regex
const NOT_TEXT = /[\u0000-\u001f\u007f‪-‮⁦-⁩]/g;

function text(v: unknown, max: number, what: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new AppearanceError(`${what} is text`);
  const s = v.replace(NOT_TEXT, ' ').replace(/\s+/g, ' ').trim();
  if (s.length > max) throw new AppearanceError(`${what} is at most ${max} characters`);
  return s || null;
}

/** A link people may follow: https (http for localhost), or an email address with mailto:. Never javascript: or data:. */
export function linkProblem(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return 'isn’t an address: start it with https://'; }
  if (u.protocol === 'mailto:') return /^[^@\s]+@[^@\s]+$/.test(decodeURIComponent(u.pathname)) ? null : 'needs an email address after mailto:';
  if (u.protocol === 'https:') return null;
  if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return null;
  return 'must start with https:// (or mailto: for an email)';
}

function url(v: unknown, what: string): string | null {
  const s = text(v, LIMITS.url, what);
  if (!s) return null;
  const problem = linkProblem(s);
  if (problem) throw new AppearanceError(`${what} ${problem}`);
  return s;
}

/** The type and size of an image in a data URL, or why it can't be used. */
export function imageOf(dataUrl: string, max: number): { type: string; bytes: number } {
  const m = /^data:([a-z+./-]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!m) throw new AppearanceError('an image is a file: PNG, SVG, WebP, JPEG, GIF or ICO');
  const type = m[1];
  if (!(IMAGE_TYPES as readonly string[]).includes(type)) throw new AppearanceError(`${type} isn’t an image the console shows: use PNG, SVG, WebP, JPEG, GIF or ICO`);
  const bytes = Math.floor((m[2].length * 3) / 4) - (m[2].endsWith('==') ? 2 : m[2].endsWith('=') ? 1 : 0);
  if (bytes > max) throw new AppearanceError(`an image is at most ${Math.round(max / 1024)} KB (this one is ${Math.ceil(bytes / 1024)} KB)`);
  return { type, bytes };
}

function image(v: unknown, max: number): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw new AppearanceError('an image is a data URL');
  imageOf(v, max);
  return v;
}

/** Checks what an admin sent (or a config file says) and gives the settings to keep. Throws AppearanceError. */
export function checkAppearance(input: unknown): Appearance {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppearanceError('send the appearance settings as an object');
  const i = input as Record<string, unknown>;
  const asked = String(i.accent ?? 'none');
  const accent = (asked in RETIRED_ACCENTS ? RETIRED_ACCENTS[asked] : asked) as Accent;
  if (!(accent in ACCENTS)) throw new AppearanceError(`the accent is one of ${Object.keys(ACCENTS).join(', ')}`);
  const accentColor = i.accentColor === undefined || i.accentColor === null || i.accentColor === '' ? null : String(i.accentColor).trim().toLowerCase();
  if (accentColor !== null && !HEX.test(accentColor)) throw new AppearanceError('the accent color is a hex color, like #2563eb');
  if (accent === 'custom' && !accentColor) throw new AppearanceError('choose the color for your own accent');
  const mode = (i.mode ?? 'device') as Mode;
  if (!(mode in MODES)) throw new AppearanceError('the default look is device, light or dark');
  let banner: Appearance['banner'] = null;
  if (i.banner !== undefined && i.banner !== null) {
    if (typeof i.banner !== 'object') throw new AppearanceError('the notice is { text, tone }');
    const b = i.banner as Record<string, unknown>;
    const t = text(b.text, LIMITS.banner, 'the notice');
    const tone = (b.tone ?? 'info') as Tone;
    if (!(tone in TONES)) throw new AppearanceError('the notice’s tone is info, warn or danger');
    banner = t ? { text: t, tone } : null;
  }
  const links = i.links ?? [];
  if (!Array.isArray(links)) throw new AppearanceError('the footer links are a list of { label, url }');
  if (links.length > LIMITS.links) throw new AppearanceError(`at most ${LIMITS.links} footer links`);
  return {
    name: text(i.name, LIMITS.name, 'the name'),
    logo: image(i.logo, LIMITS.image),
    logoDark: image(i.logoDark, LIMITS.image),
    icon: image(i.icon, LIMITS.icon),
    accent,
    accentColor: accent === 'custom' ? accentColor : null,
    mode,
    banner,
    signInNote: text(i.signInNote, LIMITS.signInNote, 'the sign-in note'),
    helpUrl: url(i.helpUrl, 'the help link'),
    links: links.map((l, n) => {
      if (!l || typeof l !== 'object') throw new AppearanceError(`footer link ${n + 1} is { label, url }`);
      const label = text((l as Link).label, LIMITS.linkLabel, `footer link ${n + 1}’s label`);
      const to = url((l as Link).url, `footer link ${n + 1}`);
      if (!label || !to) throw new AppearanceError(`footer link ${n + 1} needs a label and an address`);
      return { label, url: to };
    }),
  };
}

// ------------------------------------------------------------ colors

const channel = (hex: string, i: number) => {
  const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
/** WCAG relative luminance of #rrggbb. */
export const luminance = (hex: string) => 0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2);
/** WCAG contrast of two #rrggbb colors (1 to 21). */
export const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
/** Text on the accent: black or white, whichever reads better. */
export const inkOn = (hex: string) => (contrast(hex, '#ffffff') >= contrast(hex, '#000000') ? '#ffffff' : '#000000');

/** The page colors the accent sits on (packages/ui styles.css --page). */
export const PAGE = { light: '#ffffff', dark: '#000000' } as const;

/** The contrast the accent needs on the page: it's drawn as text and icons too (the selected page's icon, links). */
export const ACCENT_CONTRAST = 4.5;

const hex2 = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0');
/** `hex` mixed with `toward` (#rrggbb), `t` from 0 (as it is) to 1 (all `toward`). */
const mix = (hex: string, toward: string, t: number) =>
  `#${[0, 1, 2].map((i) => {
    const a = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
    const b = parseInt(toward.slice(1 + i * 2, 3 + i * 2), 16);
    return hex2(a + (b - a) * t);
  }).join('')}`;

/** A color as close to `hex` as it can be while reading on this page at 4.5:1: darker on white, lighter on black. */
export function readableOn(hex: string, mode: 'light' | 'dark'): string {
  if (contrast(hex, PAGE[mode]) >= ACCENT_CONTRAST) return hex;
  const toward = mode === 'light' ? '#000000' : '#ffffff';
  for (let t = 0.05; t < 1; t += 0.05) {
    const c = mix(hex, toward, t);
    if (contrast(c, PAGE[mode]) >= ACCENT_CONTRAST) return c;
  }
  return toward;
}

/** The accent's color in light and in dark, or null for none. One color of the installation's own is used as it is
 *  where it reads, and darkened (on light) or lightened (on dark) just enough where it doesn't. */
export function accentColors(a: Pick<Appearance, 'accent' | 'accentColor'>): { light: string; dark: string } | null {
  if (a.accent === 'custom') return a.accentColor ? { light: readableOn(a.accentColor, 'light'), dark: readableOn(a.accentColor, 'dark') } : null;
  const p = ACCENTS[knownAccent(a.accent)];
  return p.light && p.dark ? { light: p.light, dark: p.dark } : null;
}

/** Where the installation's own color doesn't read as it is (under 4.5:1 on that page), so the console uses a
 *  darker or lighter shade there: "light" or "dark". Our own accents read on both. */
export function lowContrast(a: Pick<Appearance, 'accent' | 'accentColor'>): ('light' | 'dark')[] {
  if (a.accent !== 'custom' || !a.accentColor || !HEX.test(a.accentColor)) return [];
  const c = a.accentColor;
  return (['light', 'dark'] as const).filter((m) => contrast(c, PAGE[m]) < ACCENT_CONTRAST);
}

/** The meaning colors' hues (styles.css --live, --flag, --ok, --tool), which an accent shouldn't look like. */
const MEANING_HUES: [string, number][] = [['red', 0], ['amber', 32], ['green', 142], ['purple', 265], ['red', 360]];
/** Which meaning color `hex` looks like (within 20° of its hue, and not grey), or null. */
export function nearMeaning(hex: string): string | null {
  if (!HEX.test(hex)) return null;
  const [r, g, b] = [0, 1, 2].map((i) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d < 0.2) return null;                       // grey, near black or near white
  const h = max === r ? 60 * (((g - b) / d + 6) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  return MEANING_HUES.find(([, hue]) => Math.abs(h - hue) <= 20)?.[0] ?? null;
}

/** The CSS for the accent: primary buttons and the selected item take its color (styles.css --tint). Switches and
 *  focus rings never do.
 *  Written for `html[data-theme=…]`, so it wins over the stylesheet's own values wherever it's put in the page. */
export function accentCss(a: Pick<Appearance, 'accent' | 'accentColor'>): string {
  const c = accentColors(a);
  if (!c) return '';
  const one = (m: 'light' | 'dark') => `html[data-theme="${m}"]{--tint:${c[m]};--tint-ink:${inkOn(c[m])};--tint-mark:${c[m]};`
    + `--primary-hover:color-mix(in srgb,${c[m]} 82%,${PAGE[m]})}`;
  return one('light') + one('dark');
}

// ------------------------------------------------------------ the page

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** The console's index.html with this installation's name, icon, colors and default look already in it. */
export function intoPage(html: string, a: Pick<PublicAppearance, 'name' | 'icon' | 'accent' | 'accentColor' | 'mode'>): string {
  let out = html;
  if (a.name) out = out.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(a.name)}</title>`);
  if (a.icon) out = out.replace(/<link rel="icon" href="[^"]*"/, `<link rel="icon" href="${escapeHtml(a.icon)}"`);
  if (a.mode !== 'device') out = out.replace(/<html\b/, `<html data-mode="${a.mode}"`);
  const css = accentCss(a);
  if (css) out = out.replace('</head>', `<style id="appearance">${css}</style></head>`);
  return out;
}

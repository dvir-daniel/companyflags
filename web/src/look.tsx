import { BrandMark, Wordmark } from '@companyflags/ui/components/app-frame';
import { useTheme } from '@companyflags/ui/lib/theme';
import { cn } from '@companyflags/ui/lib/utils';
import type { Tone } from '../../server/appearance.ts';
import { lookName, useLook } from './appearanceKit.ts';

/*
 * The installation's own look in the console's frame (Settings → Appearance, appearanceKit.ts): the logo and name in
 * the title bar and on the sign-in pages, the notice across the top, the links in the footer.
 */

/** The logo and the name. Without a logo: our mark. With a logo and no name of its own: the logo alone (it most
 *  likely has the name in it). */
export function Brand({ className }: { className?: string }) {
  const look = useLook();
  const { theme } = useTheme();
  const logo = theme === 'dark' ? look.logoDark ?? look.logo : look.logo;
  return (
    <span className={cn('flex min-w-0 items-center gap-2.5', className)}>
      {logo ? <img src={logo} alt={look.name ? '' : lookName(look)} className="h-5 max-w-40 shrink-0 object-contain object-left" /> : <BrandMark />}
      {/* the installation's name as it was typed ("Globex flags" stays "Globex flags") */}
      {(!logo || look.name) && <Wordmark className="truncate">{lookName(look)}</Wordmark>}
    </span>
  );
}

// The text is ink on every tone (a red or amber wash under red or amber text doesn't read): the tone is the left edge.
const TONE: Record<Tone, string> = {
  info: 'border-l-ink-4 bg-panel',
  warn: 'border-l-flag bg-flag-bg',
  danger: 'border-l-live bg-live/10',
};

/** The notice an admin set, across the top of every page: left-aligned on the page's gutter, like everything else. */
export function Banner({ banner }: { banner: { text: string; tone: Tone } | null | undefined }) {
  if (!banner) return null;
  return (
    <div role={banner.tone === 'info' ? 'note' : 'alert'}
      className={cn('shrink-0 border-b border-l-2 border-b-rule px-4 py-1.5 text-13 text-ink', TONE[banner.tone])}>
      {banner.text}
    </div>
  );
}

/** The footer's links an admin set (privacy, terms, a wiki), and Get help. */
export function LookLinks({ className }: { className?: string }) {
  const look = useLook();
  const links = [...look.links, ...(look.helpUrl ? [{ label: 'Get help', url: look.helpUrl }] : [])];
  if (!links.length) return null;
  return (
    <span className={cn('flex min-w-0 items-center gap-4', className)}>
      {links.map((l) => (
        <a key={`${l.label}-${l.url}`} href={l.url} target="_blank" rel="noopener noreferrer" className="truncate text-ink-2 hover:text-ink hover:underline">{l.label}</a>
      ))}
    </span>
  );
}

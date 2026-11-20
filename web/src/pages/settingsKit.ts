// What Settings shares with People and the other admin pages (keys, single sign-on, CDN): the roles to pick from, the
// selects' size, and the refresh after a change. Apart from Settings.tsx so that an edit to its components swaps in place
// in `pnpm dev` (React Fast Refresh); an edit here reloads the page.
import { useApp } from '../app.ts';
import { roleInfo, ROLES } from '../../../server/policy.ts';

/** The roles to choose from (policy.ts): "On call: also turns flags off in an emergency". */
export const ROLE_OPTIONS: [string, string][] = ROLES.map((r) => [r, `${roleInfo(r).label}: ${roleInfo(r).does}`]);
export const roleName = (r: string) => roleInfo(r).label;
/** A native select in a form row of these pages. */
export const selectField = 'w-full [&_select]:h-[34px] [&_select]:text-13';

/**
 * After a change that worked: the page's data again. Its result is already shown (an invite link only shows once),
 * so a reload that fails only says so.
 */
export function useRefresh() {
  const { reload, toast } = useApp();
  return () => reload().catch(() => toast('Saved. This page couldn’t refresh: reload it to see the change.', 'err'));
}

/** Settings' pages, in the order of its menu (#/settings/<key>; #/settings is the first). CDN shows when the server runs
 *  the Cloudflare plugin. Services are drawn by Settings too, but they're under Developers (#/services), not in its
 *  menu. Each label is the page's title and its tab's title, in Title Case like every page in the sidebar. */
export const SETTINGS = [
  { key: 'environments', label: 'Environments' },
  { key: 'dimensions', label: 'Dimensions' },
  { key: 'services', label: 'Services', connect: true },
  { key: 'people', label: 'People' },
  { key: 'sso', label: 'Single Sign-On' },
  { key: 'appearance', label: 'Appearance' },
  { key: 'cdn', label: 'CDN', plugin: 'cloudflare' },
  { key: 'migration', label: 'Migration' },
] as const;
export type SettingsKey = (typeof SETTINGS)[number]['key'];
/** The pages in Settings' menu on this server. */
export const settingsPages = (plugins: string[] | undefined) =>
  SETTINGS.filter((s) => !('connect' in s) && (!('plugin' in s) || (plugins ?? []).includes(s.plugin)));
/** The page an address opens: its key, or the first page for #/settings and anything unknown. */
export const settingsKey = (sub: string | undefined): SettingsKey =>
  (SETTINGS.find((s) => s.key === sub)?.key ?? 'environments');
export const isSettingsKey = (sub: string | undefined) => SETTINGS.some((s) => s.key === sub);

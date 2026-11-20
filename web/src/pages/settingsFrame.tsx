import type { ReactNode } from 'react';
import { sidebarItemClass } from '@companyflags/ui/components/app-frame';
import { cn } from '@companyflags/ui/lib/utils';
import { useApp } from '../app.ts';
import { settingsKey, settingsPages } from './settingsKit.ts';

/*
 * Settings' frame: its own menu on the left (Environments, Dimensions, Services, People, Single sign-on, Appearance,
 * CDN), and the chosen page beside it. On a phone the menu is a row of tabs above the page, scrolled sideways.
 */
export function SettingsFrame({ sub, children }: { sub: string | undefined; children: ReactNode }) {
  const { meta } = useApp();
  const at = settingsKey(sub);
  return (
    <div className="flex min-h-full flex-1 max-md:flex-col">
      <nav aria-label="Settings" className="w-[208px] shrink-0 border-r border-rule px-2 py-4 max-md:flex max-md:w-auto max-md:gap-1 max-md:overflow-x-auto max-md:border-r-0 max-md:border-b max-md:px-3 max-md:py-2">
        <p className="m-0 px-3 pb-2 font-mono text-11 tracking-[0.55px] text-ink-3 uppercase max-md:hidden">Settings</p>
        {settingsPages(meta.plugins).map((s) => (
          <a key={s.key} href={`#/settings/${s.key}`} aria-current={s.key === at ? 'page' : undefined}
            className={cn(sidebarItemClass, 'max-md:w-auto max-md:shrink-0 max-md:whitespace-nowrap')}>
            {s.label}
          </a>
        ))}
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

import type { ReactNode } from "react";
import { cn } from "../lib/utils.ts";

/**
 * Page title, 28px semibold, with an 18px subtitle in the subtitle color and key phrases (`Hi`) in the text color.
 * `actions` sit at the right of the title (the page's one main button, a search box).
 */
export function PageHeader({ title, children, actions, className }: { title: ReactNode; children?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <header className={cn("mb-[30px] flex flex-wrap items-start justify-between gap-x-6 gap-y-3", className)}>
      <div className="max-w-[780px] min-w-0">
        <h1 className="m-0 text-28 leading-[1.2] font-semibold tracking-[-0.02em]">{title}</h1>
        {children ? <p className="mt-2 mb-0 text-lg font-normal text-subtitle">{children}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** A key phrase inside a subtitle. */
export function Hi({ children }: { children: ReactNode }) {
  return <span className="font-medium text-ink">{children}</span>;
}

/** Section label in mono caps followed by a hairline rule. */
export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <h2
      className={cn(
        "mt-10 mb-3.5 flex max-w-[780px] items-center gap-3 font-mono text-13 leading-none font-normal tracking-normal text-ink uppercase after:h-px after:flex-1 after:bg-rule",
        className,
      )}
    >
      {children}
    </h2>
  );
}

/** Rounded pill: only for announcements and phase tags. */
export function Pill({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full bg-rule/80 px-[9px] py-px font-mono text-11 whitespace-nowrap text-ink-3 uppercase">
      {children}
    </span>
  );
}

import * as React from "react"
import { cn } from "../lib/utils.ts"
import { heroActionClass } from "./hero-classes.ts"

/*
 * A page's header in better-auth's hero style: a framed panel with + marks at its corners and the
 * dithered texture on the right; a pill, the title, one sentence; and along its bottom an optional bar of
 * mono caps cells (environments, filters, facts), the open one underlined, ending in an inverted action.
 *
 *   <PageHero pill="Release flag" title="new_checkout" aside={<Button variant="secondary">Copy key</Button>}
 *     bar={<><HeroCell href="#/x/dev" current>Development</HeroCell><HeroBarSpacer /><HeroAction>Turn off</HeroAction></>}>
 *     One sentence about it.
 *   </PageHero>
 */

function PageHero({
  pill,
  title,
  aside,
  bar,
  children,
  className,
  titleClassName,
}: {
  pill?: React.ReactNode
  title: React.ReactNode
  aside?: React.ReactNode
  bar?: React.ReactNode
  children?: React.ReactNode
  className?: string
  titleClassName?: string
}) {
  return (
    <section data-slot="page-hero" className={cn("crosshairs", className)}>
      <div className="dither border border-grid">
        <div className="relative z-[1] px-8 pt-7 pb-9 max-sm:px-5 max-sm:pt-5 max-sm:pb-6">
          {pill ? (
            <span className="mb-5 inline-block rounded-full bg-rule/80 px-[9px] py-px font-mono text-11 whitespace-nowrap text-ink-3 uppercase">{pill}</span>
          ) : null}
          <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
            <h1 className={cn("m-0 min-w-0 text-[32px] leading-[1.15] font-semibold tracking-[-0.025em] [overflow-wrap:anywhere] text-ink max-sm:text-28", titleClassName)}>
              {title}
            </h1>
            {aside ? <div className="flex shrink-0 items-center gap-2 pt-1.5">{aside}</div> : null}
          </div>
          {children ? <div className="m-0 mt-2.5 max-w-[680px] text-base text-subtitle">{children}</div> : null}
        </div>
        {bar ? (
          <div data-slot="page-hero-bar" className="relative z-[1] flex border-t border-grid bg-background max-sm:flex-wrap">
            {bar}
          </div>
        ) : null}
      </div>
    </section>
  )
}

const heroCellClass =
  "flex h-12 shrink-0 items-center gap-2.5 border-r border-sep px-5 font-mono text-xs tracking-[0.6px] uppercase no-underline hover:no-underline max-sm:flex-1 max-sm:px-4"

/**
 * A cell in the hero's bar. With `href` or `onClick` it is a tab-like control (the open one is `current`,
 * underlined); without either it shows a fact ("12 keys").
 */
function HeroCell({
  href,
  onClick,
  current,
  children,
  className,
  ...props
}: {
  href?: string
  onClick?: () => void
  current?: boolean
  children: React.ReactNode
  className?: string
} & Omit<React.HTMLAttributes<HTMLElement>, "onClick">) {
  const cls = cn(
    heroCellClass,
    current ? "text-ink shadow-[inset_0_-2px_0_var(--underline)]" : href || onClick ? "text-ink-nav hover:text-ink" : "text-ink-2",
    className
  )
  if (href)
    return (
      <a href={href} aria-current={current ? "page" : undefined} className={cls} {...props}>
        {children}
      </a>
    )
  if (onClick)
    return (
      <button type="button" onClick={onClick} aria-pressed={current} className={cn(cls, "cursor-default rounded-none border-y-0 border-l-0 bg-transparent")} {...props}>
        {children}
      </button>
    )
  return (
    <span className={cls} {...props}>
      {children}
    </span>
  )
}

/** Pushes the cells after it to the right end of the bar. */
function HeroBarSpacer() {
  return <span className="flex-1 max-sm:hidden" />
}

/** The inverted action at the end of the bar ("Turn off", "+ New flag"). */
function HeroAction({ className, href, ...props }: React.ComponentProps<"button"> & { href?: string }) {
  if (href)
    return (
      <a href={href} className={cn(heroActionClass, className)}>
        {props.children}
      </a>
    )
  return <button type="button" className={cn(heroActionClass, className)} {...props} />
}

export { HeroAction, HeroBarSpacer, HeroCell, PageHero, heroActionClass }

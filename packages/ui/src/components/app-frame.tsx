import * as React from "react"
import { cn } from "../lib/utils.ts"
import { sidebarItemClass } from "./app-frame-classes.ts"
import { Badge } from "./badge.tsx"
import { Kbd } from "./kbd.tsx"

/*
 * The console window: a 44px title bar, a 232px docs-style sidebar,
 * one main pane that scrolls (the window itself doesn't) and a 34px mono footer with slashes.
 *
 *   <AppFrame titleBar={<TitleBar>…</TitleBar>} sidebar={<Sidebar>…</Sidebar>} footer={<Footer>…</Footer>}>
 *     <MainPane>…page…</MainPane>
 *   </AppFrame>
 *
 * Every part takes className and the usual element props, so an app can add its own
 * (a router's active state, and so on).
 * In a narrow window (under 768px) the app hides the sidebar and the footer and shows its own bottom tab
 * bar instead (the console's MobileNav; DESIGN.md "Patterns"): the frame's grid then gives the page the width.
 */

function AppFrame({
  titleBar,
  sidebar,
  footer,
  children,
  className,
}: {
  titleBar: React.ReactNode
  sidebar?: React.ReactNode
  footer?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <div data-slot="app-frame" className={cn("flex h-full flex-col", className)}>
      {titleBar}
      <div className={cn("min-h-0 flex-1", sidebar ? "grid grid-cols-[232px_minmax(0,1fr)] max-md:grid-cols-1 max-md:grid-rows-[auto_minmax(0,1fr)]" : "flex flex-col")}>
        {sidebar}
        {children}
      </div>
      {footer}
    </div>
  )
}

/* ---------------------------------------------------------------- title bar */

function TitleBar({ className, ...props }: React.ComponentProps<"header">) {
  return <header data-slot="title-bar" className={cn("flex h-11 shrink-0 items-stretch border-b border-rule", className)} {...props} />
}

/** The left cluster: the mark (or the installation's logo) and the name. */
function TitleBarBrand({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="title-bar-brand" className={cn("flex items-center gap-2.5 pr-4 pl-4", className)} {...props} />
}

/** The product's mark: three stepped bars, the layers from the defaults down to one entry. Drawn in the text color. */
function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" className={cn("shrink-0", className)}>
      <path d="M0 0h16v4H0zM0 6h11v4H0zM0 12h6v4H0z" fill="currentColor" />
    </svg>
  )
}

/** The console's name in the title bar, as it is written: the installation's own name, or CompanyFlags. */
function Wordmark({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="wordmark" className={cn("text-sm leading-none font-semibold tracking-[0.01em]", className)} {...props} />
}

/** A quiet mono word after the wordmark, such as "demo". */
function WordmarkTag({ className, ...props }: React.ComponentProps<"span">) {
  return <span className={cn("ml-1.5 font-mono text-11 text-ink-3", className)} {...props} />
}

/** A mono caps cell at the right of the bar, such as "Synced". `warn` turns it amber. */
function TitleBarStatus({ warn, className, ...props }: React.ComponentProps<"div"> & { warn?: boolean }) {
  return (
    <div
      data-slot="title-bar-status"
      className={cn(
        "flex items-center border-l border-sep px-4 font-mono text-xs tracking-[0.6px] uppercase",
        warn ? "text-flag" : "text-ink-nav",
        className
      )}
      {...props}
    />
  )
}

/* ---------------------------------------------------------------- sidebar */

function Sidebar({ className, ...props }: React.ComponentProps<"nav">) {
  return (
    <nav
      data-slot="sidebar"
      className={cn(
        "flex min-h-0 flex-col gap-px overflow-auto border-r border-rule bg-sidebar px-4 py-3.5",
        className
      )}
      {...props}
    />
  )
}

/** The search box at the top of the sidebar; it opens the app's search (usually on ⌘K). */
function SidebarSearch({
  icon,
  shortcut = "⌘K",
  children,
  className,
  ...props
}: React.ComponentProps<"button"> & { icon?: React.ReactNode; shortcut?: string }) {
  return (
    <button
      type="button"
      data-slot="sidebar-search"
      className={cn(
        "mb-5 flex h-8 w-full shrink-0 cursor-default items-center gap-[9px] border border-rule bg-transparent pr-1.5 pl-2.5 text-left text-sm text-ink-nav hover:border-rule-2 hover:text-ink-1",
        className
      )}
      {...props}
    >
      {icon}
      <span>{children}</span>
      {shortcut ? <Kbd className="ml-auto">{shortcut}</Kbd> : null}
    </button>
  )
}

function SidebarLabel({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sidebar-label" className={cn("px-3 pb-1.5 font-mono text-11 text-ink-3 uppercase", className)} {...props} />
}

/**
 * A titled group of sidebar links. Groups sit 20px apart and a title sits 6px above its own links, so each
 * title reads as part of its group, not the one above (proximity). Screen readers announce the group by name.
 */
function SidebarGroup({ label, className, children, ...props }: React.ComponentProps<"div"> & { label?: React.ReactNode }) {
  const id = React.useId()
  // with no title: the links alone, spaced from the groups around them
  if (label === undefined)
    return (
      <div data-slot="sidebar-group" className={cn("flex flex-col gap-px [&+&]:mt-5", className)} {...props}>
        {children}
      </div>
    )
  return (
    <div role="group" aria-labelledby={id} data-slot="sidebar-group" className={cn("flex flex-col gap-px [&+&]:mt-5", className)} {...props}>
      <SidebarLabel id={id}>{label}</SidebarLabel>
      {children}
    </div>
  )
}

/** A sidebar link as a plain anchor. */
function SidebarItem({ className, ...props }: React.ComponentProps<"a">) {
  // oxlint-disable-next-line jsx-a11y/anchor-has-content -- the link's text is its children, in props
  return <a data-slot="sidebar-item" className={cn(sidebarItemClass, className)} {...props} />
}

/** The white count at the end of a sidebar item ("3 to review"). */
function SidebarCount({ className, ...props }: React.ComponentProps<"span">) {
  return <Badge variant="count" className={cn("ml-auto", className)} {...props} />
}

/** The block pinned to the bottom of the sidebar: status, then who is signed in. */
function SidebarFoot({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sidebar-foot" className={cn("mt-auto border-t border-rule px-3 pt-3 pb-0.5", className)} {...props} />
}

/** A person's square with their initials, in their own attribution color. */
function Avatar({ initials, color, size = 24, className }: { initials: string; color: string; size?: 20 | 24; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-grid shrink-0 place-items-center font-mono text-[10px] font-medium text-person-ink", size === 24 ? "size-6" : "size-5", className)}
      style={{ background: color }}
    >
      {initials}
    </span>
  )
}

/* ---------------------------------------------------------------- main pane */

/**
 * The scrolling pane right of the sidebar. Pages sit in a centred column (860px, or 1080px with
 * `wide`); `fluid` gives a dense console page the full width with no padding (its PageBar sticks to the
 * top, its table fills the rest); `fullBleed` hands the whole pane to a page that lays out its own panes.
 */
function MainPane({
  wide,
  fullBleed,
  fluid,
  className,
  children,
  ...props
}: React.ComponentProps<"main"> & { wide?: boolean; fullBleed?: boolean; fluid?: boolean }) {
  return (
    <main
      data-slot="main-pane"
      tabIndex={-1}
      className={cn(
        "min-h-0 outline-none",
        fullBleed ? "overflow-hidden" : fluid ? "overflow-auto" : "overflow-auto px-11 pt-9 pb-[72px] max-md:px-4 max-md:pt-5 max-md:pb-12",
        className
      )}
      {...props}
    >
      {fullBleed ? children : fluid ? <div className="flex min-h-full w-full flex-col">{children}</div> : <div className={cn("mx-auto w-full", wide ? "max-w-[1080px]" : "max-w-[860px]")}>{children}</div>}
    </main>
  )
}

/* ---------------------------------------------------------------- footer */

function Footer({ className, ...props }: React.ComponentProps<"footer">) {
  return (
    <footer
      data-slot="footer"
      className={cn("flex h-[34px] shrink-0 items-center gap-2.5 border-t border-rule px-4 font-mono text-11 whitespace-nowrap text-ink-nav", className)}
      {...props}
    />
  )
}

function FooterSlash() {
  return <span className="text-ink-4">/</span>
}

export {
  AppFrame,
  Avatar,
  BrandMark,
  Footer,
  FooterSlash,
  MainPane,
  Sidebar,
  SidebarCount,
  SidebarFoot,
  SidebarGroup,
  SidebarItem,
  SidebarLabel,
  SidebarSearch,
  TitleBar,
  TitleBarBrand,
  TitleBarStatus,
  Wordmark,
  WordmarkTag,
  sidebarItemClass,
}

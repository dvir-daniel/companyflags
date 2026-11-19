import * as React from "react"
import { cn } from "../lib/utils.ts"
import { panelHeadClass, panelRowClass } from "./panel-classes.ts"

/*
 * A framed section of a page: a header bar (an optional number square, a title with a count, one sentence,
 * actions at the right), the content, and an optional footer strip for adding or paging. + marks at its
 * bottom corners. Tables and lists go in with `flush` so their rows run edge to edge.
 *
 *   <Panel n={1} title="Defaults" desc="What everyone gets." actions={<Button>…</Button>} footer={<Button>+ Add rule</Button>}>
 *     …rows…
 *   </Panel>
 */
function Panel({
  n,
  title,
  count,
  desc,
  actions,
  footer,
  flush,
  className,
  children,
  ...props
}: {
  n?: React.ReactNode
  title?: React.ReactNode
  count?: React.ReactNode
  desc?: React.ReactNode
  actions?: React.ReactNode
  footer?: React.ReactNode
  flush?: boolean
  className?: string
  children?: React.ReactNode
} & Omit<React.HTMLAttributes<HTMLElement>, "title">) {
  return (
    <section data-slot="panel" className={cn("crosshairs mt-7", className)} {...props}>
      <div className="border border-grid">
        {title || actions ? (
          <header className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-grid px-5 py-4 max-sm:px-4">
            {n !== undefined ? (
              <span className="inline-grid size-8 shrink-0 place-items-center border border-rule-2 font-mono text-13 text-ink">{n}</span>
            ) : null}
            <div className="min-w-0 flex-1 basis-[260px]">
              {title ? (
                <h2 className="m-0 flex items-baseline gap-2 text-15 leading-tight font-semibold tracking-normal text-ink">
                  {title}
                  {count !== undefined ? <span className="font-mono text-13 font-normal text-ink-3">{count}</span> : null}
                </h2>
              ) : null}
              {desc ? <p className="m-0 mt-0.5 text-13 text-ink-2">{desc}</p> : null}
            </div>
            {actions ? <div className="flex flex-wrap items-center gap-2 max-sm:w-full">{actions}</div> : null}
          </header>
        ) : null}
        {children ? <div className={flush ? undefined : "px-5 max-sm:px-4"}>{children}</div> : null}
        {footer ? (
          <footer className="flex flex-wrap items-center gap-2 border-t border-grid bg-panel px-5 py-3 max-sm:px-4">{footer}</footer>
        ) : null}
      </div>
    </section>
  )
}

export { Panel, panelHeadClass, panelRowClass }

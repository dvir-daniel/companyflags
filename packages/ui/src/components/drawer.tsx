import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { XIcon } from "@phosphor-icons/react"
import { cn } from "../lib/utils.ts"
import { BAR_CONTROLS } from "./page-bar-classes.ts"
import { useBottomReserve } from "./toast-manager.ts"

/*
 * A drawer that slides over the page from the right (Stripe's detail sheet): the table stays where it
 * was, Esc or the backdrop closes it, focus comes back to the row.
 *
 *   <Drawer open={!!key} onClose={() => setKey(null)} title={key} subtitle="Release · Boolean" footer={<Button>Open flag</Button>}>
 *     …
 *   </Drawer>
 */
function Drawer({
  open,
  onClose,
  title,
  subtitle,
  actions,
  footer,
  width = 560,
  initialFocus,
  children,
}: {
  open: boolean
  onClose: () => void
  title: React.ReactNode
  subtitle?: React.ReactNode
  actions?: React.ReactNode
  footer?: React.ReactNode
  width?: number
  /** Where focus starts when it opens, e.g. a form's first field (default: the Close button). */
  initialFocus?: React.RefObject<HTMLElement | null>
  children: React.ReactNode
}) {
  const reserve = useBottomReserve()
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-overlay transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <DialogPrimitive.Popup
          data-slot="drawer"
          initialFocus={initialFocus}
          style={{ width: `min(${width}px, 100vw)` }}
          className={cn(
            "fixed inset-y-0 right-0 z-50 flex flex-col border-l border-rule-2 bg-background text-ink shadow-[0_0_80px_var(--shadow-strong)] outline-none",
            "transition-transform duration-200 ease-out data-ending-style:translate-x-full data-starting-style:translate-x-full"
          )}
        >
          <header className="flex min-h-14 shrink-0 items-start gap-3 border-b border-rule px-6 py-3.5 max-sm:px-4">
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="m-0 truncate text-15 leading-tight font-semibold text-ink">{title}</DialogPrimitive.Title>
              {subtitle ? <p className="m-0 mt-0.5 text-13 text-ink-2">{subtitle}</p> : null}
            </div>
            {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
            <DialogPrimitive.Close
              aria-label="Close"
              className="-mr-2 inline-grid size-8 shrink-0 cursor-default place-items-center border-0 bg-transparent text-ink-3 hover:bg-wash hover:text-ink"
            >
              <XIcon className="size-4" />
            </DialogPrimitive.Close>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 max-sm:px-4">{children}</div>
          {footer ? <footer ref={reserve} className={cn("flex shrink-0 flex-wrap items-center gap-2 border-t border-rule bg-panel px-6 py-3 max-sm:px-4", BAR_CONTROLS)}>{footer}</footer> : null}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

/** A label and value row inside a drawer. */
function DrawerRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] items-baseline gap-4 border-b border-grid py-2.5 text-13 last:border-b-0">
      <span className="text-ink-3">{label}</span>
      <span className="min-w-0 text-ink [overflow-wrap:anywhere]">{children}</span>
    </div>
  )
}

/** A section title inside a drawer, in mono caps. */
function DrawerSection({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("mt-6 first:mt-0", className)}>
      <h3 className="m-0 mb-1 font-mono text-11 font-normal tracking-[0.55px] text-ink-3 uppercase">{title}</h3>
      {children}
    </section>
  )
}

export { Drawer, DrawerRow, DrawerSection }

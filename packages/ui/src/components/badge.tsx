import * as React from "react"
import type { VariantProps } from "class-variance-authority"
import { cn } from "../lib/utils.ts"
import { badgeVariants } from "./badge-variants.ts"

function Badge({ className, variant, ...props }: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
}

/** A small square status mark (on, off, live). Squares, never dots. */
function StatusMark({ tone = "ok", pulse, className }: { tone?: "ok" | "live" | "warn" | "off"; pulse?: boolean; className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-slot="status-mark"
      className={cn(
        "inline-block size-[7px] shrink-0",
        tone === "ok" && "bg-ok",
        tone === "live" && "bg-live",
        tone === "warn" && "bg-flag",
        tone === "off" && "border-[1.5px] border-ink-3",
        pulse && "animate-pulse-live",
        className
      )}
    />
  )
}

export { Badge, StatusMark, badgeVariants }

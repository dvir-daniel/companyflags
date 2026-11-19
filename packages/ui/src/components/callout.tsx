import * as React from "react"
import type { VariantProps } from "class-variance-authority"
import { cn } from "../lib/utils.ts"
import { calloutVariants } from "./callout-variants.ts"

function Callout({ className, tone, ...props }: React.ComponentProps<"div"> & VariantProps<typeof calloutVariants>) {
  return <div data-slot="callout" className={cn(calloutVariants({ tone }), className)} {...props} />
}

export { Callout, calloutVariants }

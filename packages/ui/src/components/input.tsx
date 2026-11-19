import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"
import { cn } from "../lib/utils.ts"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "h-[38px] w-full min-w-0 rounded-none border border-input bg-background px-3 py-2 text-sm text-ink transition-colors outline-none select-text placeholder:text-ink-4 hover:border-ink-3 focus-visible:border-ink disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive",
        className
      )}
      {...props}
    />
  )
}

export { Input }

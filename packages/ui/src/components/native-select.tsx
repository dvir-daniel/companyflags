import * as React from "react"
import { CaretDownIcon } from "@phosphor-icons/react"
import { cn } from "../lib/utils.ts"

/**
 * The browser's own <select>, drawn like `Input`. Use it for long or plain option lists and in dense
 * editors; use `Select` when the options need their own layout.
 * size: "default" is 38px like `Input`; "sm" is 32px for rows of controls.
 */
function NativeSelect({
  className,
  size = "default",
  ...props
}: Omit<React.ComponentProps<"select">, "size"> & { size?: "default" | "sm" }) {
  return (
    <span data-slot="native-select-wrapper" className={cn("relative inline-flex min-w-0", className)}>
      <select
        data-slot="native-select"
        data-size={size}
        className={cn(
          "w-full min-w-0 cursor-default appearance-none rounded-none border border-input bg-background bg-none pr-8 pl-3 text-sm text-ink outline-none transition-colors",
          "hover:border-ink-3 focus-visible:border-ink disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive",
          size === "sm" ? "h-8" : "h-[38px]"
        )}
        {...props}
      />
      <CaretDownIcon aria-hidden="true" className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-ink-3" />
    </span>
  )
}

export { NativeSelect }

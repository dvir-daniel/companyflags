import * as React from "react"
import { Button as ButtonPrimitive } from "@base-ui/react/button"
import type { VariantProps } from "class-variance-authority"
import { cn } from "../lib/utils.ts"
import { buttonVariants } from "./button-variants.ts"
import { Tooltip } from "./tooltip.tsx"

/**
 * A button. A disabled one with a `title` says why it can't be used: it stays reachable with Tab (it does nothing
 * when pressed), shows the reason on hover and focus, and screen readers hear it as the button's description.
 *
 *   <Button disabled={!mayChange} title="Viewers can look but not change anything">Turn off</Button>
 */
function Button({
  className,
  variant = "default",
  size = "default",
  disabled,
  title,
  focusableWhenDisabled,
  "aria-describedby": describedBy,
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  const why = React.useId()
  const explained = !!disabled && typeof title === "string" && title.trim() !== ""
  const button = (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      disabled={disabled}
      focusableWhenDisabled={explained || focusableWhenDisabled}
      title={explained ? undefined : title}
      aria-describedby={explained ? [describedBy, why].filter(Boolean).join(" ") : describedBy}
      {...props}
    />
  )
  if (!explained) return button
  return (
    <>
      <Tooltip content={title}>{button}</Tooltip>
      <span id={why} hidden>
        {title}
      </span>
    </>
  )
}

export { Button, buttonVariants }

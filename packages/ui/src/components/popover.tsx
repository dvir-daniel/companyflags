import { Popover as PopoverPrimitive } from "@base-ui/react/popover"
import { cn } from "../lib/utils.ts"

/**
 * Popovers in this style: a square panel with a 1px rule that floats over the page, so
 * opening one never moves anything. Keyboard reachable through its trigger; Esc closes it.
 */
function Popover(props: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger(props: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverContent({
  className,
  side = "bottom",
  align = "start",
  sideOffset = 6,
  children,
  ...props
}: PopoverPrimitive.Popup.Props & Pick<PopoverPrimitive.Positioner.Props, "side" | "align" | "sideOffset">) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner side={side} align={align} sideOffset={sideOffset} className="z-50">
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            "w-72 border border-rule-2 bg-panel px-3.5 py-3 text-13 text-ink-1 shadow-[0_16px_48px_var(--shadow-strong)] outline-none",
            "transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0",
            className
          )}
          {...props}
        >
          {children}
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
}

const PopoverTitle = PopoverPrimitive.Title
const PopoverDescription = PopoverPrimitive.Description

export { Popover, PopoverTrigger, PopoverContent, PopoverTitle, PopoverDescription }

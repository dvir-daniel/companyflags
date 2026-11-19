import * as React from "react"
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"
import { QuestionIcon } from "@phosphor-icons/react"
import { cn } from "../lib/utils.ts"

/*
 * A short explanation that floats over the page on hover or keyboard focus. Opening one never moves
 * anything. For longer help or anything clickable, use a Popover.
 *
 *   <Tooltip content="Every app uses the default in its code.">
 *     <button>Off</button>
 *   </Tooltip>
 */
function Tooltip({
  content,
  children,
  side = "top",
  align = "center",
  delay = 300,
  className,
}: {
  content: React.ReactNode
  children: React.ReactElement
  side?: "top" | "bottom" | "left" | "right"
  align?: "start" | "center" | "end"
  delay?: number
  className?: string
}) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger delay={delay} render={children} />
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner side={side} align={align} sideOffset={6} className="z-[60]">
          <TooltipPrimitive.Popup
            data-slot="tooltip"
            className={cn(
              "max-w-72 border border-rule-2 bg-panel px-3 py-2 font-sans text-13 leading-snug font-normal tracking-normal text-ink-1 normal-case shadow-[0_12px_32px_var(--shadow-strong)]",
              "transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0",
              className
            )}
          >
            {content}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}

/**
 * Inline help (the paradox of the active user: nobody reads the manual, so the answer sits next to the
 * term). A small "?" after a label; hover or focus shows one or two plain sentences.
 *
 *   <span>Sent to <HelpTip>The apps that receive this flag in this environment.</HelpTip></span>
 */
function HelpTip({ children, label, className }: { children: React.ReactNode; label?: string; className?: string }) {
  return (
    <Tooltip content={children}>
      <button
        type="button"
        data-slot="help-tip"
        aria-label={label ?? (typeof children === "string" ? children : "What's this?")}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "relative inline-grid size-3.5 shrink-0 cursor-help place-items-center border-0 bg-transparent p-0 align-[-2px] text-ink-4 outline-none hover:text-ink focus-visible:text-ink",
          "after:absolute after:-inset-1.5 after:content-['']",
          className
        )}
      >
        <QuestionIcon aria-hidden className="size-3.5" />
      </button>
    </Tooltip>
  )
}

export { HelpTip, Tooltip }

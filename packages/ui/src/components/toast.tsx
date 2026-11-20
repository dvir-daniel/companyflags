import { Toast as ToastPrimitive } from "@base-ui/react/toast"
import { cn } from "../lib/utils.ts"
import { notify, toast, useBottomReserve, type NotifyAction } from "./toast-manager.ts"

/**
 * Toasts in this style: an inverted white strip at the bottom right of the main pane,
 * with an optional underlined action ("Undo", "Review", "Open"). Up to three stack, the newest at the
 * bottom; a new one never pushes out one with an action (toast-manager.ts notify).
 */
function ToastViewport({ className, ...props }: ToastPrimitive.Viewport.Props) {
  return (
    <ToastPrimitive.Viewport
      data-slot="toast-viewport"
      className={cn(
        "pointer-events-none fixed right-5 bottom-[calc(52px+var(--bottom-bar-h,0px))] left-[248px] z-[70] flex flex-col-reverse items-end gap-2 outline-none max-md:left-4",
        className
      )}
      {...props}
    />
  )
}

function Toast({ className, ...props }: ToastPrimitive.Root.Props) {
  return (
    <ToastPrimitive.Root
      data-slot="toast"
      className={cn(
        "pointer-events-auto flex max-w-[560px] items-center gap-4 data-limited:hidden bg-ink px-3.5 py-[9px] text-13 text-background outline-none select-none data-[type=error]:bg-live",
        "transition-[opacity,translate] duration-200 ease-out data-ending-style:opacity-0 data-starting-style:translate-y-2 data-starting-style:opacity-0 motion-reduce:transition-opacity motion-reduce:data-starting-style:translate-y-0",
        "focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-ink",
        className
      )}
      {...props}
    />
  )
}

function ToastTitle({ className, ...props }: ToastPrimitive.Title.Props) {
  return <ToastPrimitive.Title data-slot="toast-title" className={cn("font-normal", className)} {...props} />
}

function ToastAction({ className, ...props }: ToastPrimitive.Action.Props) {
  return (
    <ToastPrimitive.Action
      data-slot="toast-action"
      className={cn(
        "shrink-0 cursor-default border-0 bg-transparent p-0 text-11 font-medium tracking-[0.55px] text-background uppercase underline underline-offset-[3px]",
        className
      )}
      {...props}
    />
  )
}

function ToastList() {
  const { toasts } = ToastPrimitive.useToastManager()
  return toasts.map((t) => (
    <Toast key={t.id} toast={t}>
      <ToastTitle />
      <ToastAction />
    </Toast>
  ))
}

function Toaster({ children, toastManager = toast, ...props }: ToastPrimitive.Provider.Props) {
  return (
    <ToastPrimitive.Provider toastManager={toastManager} timeout={6000} limit={3} {...props}>
      {children}
      <ToastPrimitive.Portal>
        <ToastViewport>
          <ToastList />
        </ToastViewport>
      </ToastPrimitive.Portal>
    </ToastPrimitive.Provider>
  )
}

export { Toaster, Toast, ToastAction, ToastTitle, ToastViewport, notify, toast, useBottomReserve }
export type { NotifyAction }

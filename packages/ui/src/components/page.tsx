import type { ReactNode } from "react";
import { cn } from "../lib/utils.ts";

/** Section label in mono caps followed by a hairline rule. */
export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <h2
      className={cn(
        "mt-10 mb-3.5 flex max-w-[780px] items-center gap-3 font-mono text-13 leading-none font-normal tracking-normal text-ink uppercase after:h-px after:flex-1 after:bg-rule",
        className,
      )}
    >
      {children}
    </h2>
  );
}

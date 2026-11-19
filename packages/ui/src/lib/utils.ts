import { createCn } from "cn/config"

/**
 * Class merging that knows the type scale (text-11, text-13, text-15, text-28),
 * so `cn("text-xs", "text-11")` keeps only `text-11`.
 */
export const cn = createCn({
  extend: { classGroups: { "font-size": [{ text: ["11", "13", "15", "28"] }] } },
})

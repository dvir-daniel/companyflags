// The arrow keys in a group with one Tab stop (tabs, a radio group): which item a key moves to. Kept out of the
// components' files so they hot-swap when edited (Fast Refresh only swaps a file whose exports are all components).

/**
 * The index an arrow key (or Home, End) moves to from `from`, skipping items that can't be chosen and wrapping
 * around; null for any other key. `axis`: "horizontal" (←/→), or "both" (←/→ and ↑/↓, as a radio group).
 */
export function arrowTarget(key: string, from: number, enabled: boolean[], axis: "horizontal" | "both" = "horizontal"): number | null {
  const n = enabled.length
  if (!n || !enabled.some(Boolean)) return null
  const step = (start: number, dir: 1 | -1) => {
    let i = start
    for (let k = 0; k < n; k++) {
      i = (i + dir + n) % n
      if (enabled[i]) return i
    }
    return null
  }
  const back = key === "ArrowLeft" || (axis === "both" && key === "ArrowUp")
  const fwd = key === "ArrowRight" || (axis === "both" && key === "ArrowDown")
  if (fwd) return step(from, 1)
  if (back) return step(from, -1)
  if (key === "Home") return enabled.indexOf(true)
  if (key === "End") return n - 1 - [...enabled].reverse().indexOf(true)
  return null
}

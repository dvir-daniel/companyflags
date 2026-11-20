# Console design rules

How the CompanyFlags console looks and behaves. `src/styles.css` holds the values as tokens, and the components in
`src/components` apply them. Change a rule here and in the tokens together.

The console shares better-auth.com's tokens and grid: pure black and white, Geist and Geist Mono, square corners, 1px
lines, color only for meaning. It doesn't share its marketing layout. The console is a dense work tool, like Linear or
Stripe: a page bar over a full-width table, and a drawer for one record. The hero layouts, "+" marks and dithered
textures of better-auth.com belong to the docs site and the landing page (`docs/`), not here.

## Themes

Two themes: **dark** (pure black) and **light** (white). The title bar's `ThemeToggle` moves through **Light**,
**Dark** and **Auto**. Auto is the installation's default (Settings → Appearance) or, with none, the device's setting,
and it follows the device when that changes. `src/lib/theme.ts` keeps the choice and sets `<html data-theme>`.
Components use tokens only (`bg-background`, `text-ink`, `border-rule`), never a fixed black or white.

| | Dark | Light |
| --- | --- | --- |
| Page | #000 | #FFF |
| Panels | #0A0A0A, #121212 | #FAFAFA, #F5F5F5 |
| Text | #FAFAFA; nav at 65%; muted #A3A3A3, #808080 | #0A0A0A; nav at 60%; muted #525252, #737373 |
| Lines | #262626, #363636; rows at 8% white | #E5E5E5, #D4D4D4; rows at 8% black |
| Control edges | #6B6B6B | #888888 |
| Primary | white, black text | #0A0A0A, white text |
| Meaning colors | red #FF5A4E, amber #E8B864, green #7EE0A8, purple #B48CF5 | red #DC2626, amber #B45309, green #15803D, purple #7C3AED |

## Color

- **Text reads.** All text, placeholders included, is at least 4.5:1 on its background, and icons at least 3:1. The
  quietest text is `text-ink-3`; dimmed text is `text-ink-nav`. `text-ink-4` is decoration only (slashes, rules).
- **Controls read.** The edge of an input, a checkbox, a switch or a select is `--control-edge` (`border-input`,
  `border-control-edge`), at 3:1 or more on the page and on panels. `--rule` and `--grid` are for lines that only
  decorate. `test/web-tokens.test.ts` checks both themes.
- **Color only for meaning:** each person's own color; red for production, problems and destructive actions; amber for
  what waits on someone (approvals, protected environments); green for on and done; purple for what an agent did.
- **No brand color.** The primary is the text color.
- **An installation's accent** (Settings → Appearance, `server/appearance.ts`) recolors `--tint`: primary buttons
  (`bg-primary`), the selected sidebar item's edge and icon, the pager's page and the chosen `Segmented` option. It
  never colors switches (on is ink), counts (amber) or focus rings (`--ring` is ink). The presets are blue, indigo and
  teal: none of them is a meaning color. A color of the installation's own is used as typed where it reads at 4.5:1,
  and darkened (light) or lightened (dark) just enough where it doesn't; the form warns when it looks like a meaning
  color.

## Type

- Geist for text; Geist Mono for labels, times, counts, keys and code.
- Scale: 11 / 12 / 13 / 14 / 15 / 16 / 18 / 22 / 28 px. Weights 400 / 500 / 600 (emphasis is 500). Line height 1.5.
- **Three title sizes:** 15px in the page bar (every console page), 22px for one record's headline (an entity, a
  release's state), 28px for a page that stands alone (setup, page not found, an error). Sign-in uses 22px.
- The installation's name is shown as it was typed, in the title bar and the tab's title.

## Shape and grid

- Square corners everywhere, 1px lines. Status marks are squares, not dots.
- Panes sit edge to edge, divided by lines, not floating cards. `Panel` stacks show "+" marks where lines meet.
- One left edge: 24px page gutters (`px-6`, 16px on a phone) for the page bar, strips, tables and bulk bar.
- Spacing in 4px steps.

## The window

| Part | Component |
| --- | --- |
| 44px title bar: the logo or mark and name, the theme, Synced | `TitleBar`, `TitleBarBrand`, `Wordmark`, `ThemeToggle`, `TitleBarStatus` |
| 232px sidebar: Search (⌘K), then the pages in groups, then what's published and who you are | `Sidebar`, `SidebarSearch`, `SidebarGroup`, `SidebarItem`, `SidebarCount`, `SidebarFoot` |
| The scrolling main pane; dense pages take its full width (`fluid`) | `MainPane` |
| 34px mono footer with slashes | `Footer`, `FooterSlash` |
| Phone (under 768px): a bottom tab bar with the four most-used pages and More, which opens the sidebar in a `Drawer` | the console's `MobileNav` (web/src/shell.tsx), `useBottomReserve` |

**The sidebar's groups** say what people come for. The first group has no title: Flags, Releases, Approvals,
History. **Targeting**: each dimension's page, and Compare. **Connect**: what talks to the server (Services, API keys,
Access tokens, Webhooks, Migration). **Settings** sits on its own at the end. A group with one item gets no title,
and no group is named after its only item.

**One home for each question.** What changed, and how to undo it, is **History**, in three views with their own
addresses: Changes (`#/history`), Revisions (`#/history?view=revisions&env=…`, each environment's numbered
published states, with roll back; `?view=versions` works too) and Requests
(`#/history?view=requests`). **Approvals** is the reviewer's inbox of open requests and links to History. A flag's
History tab is the same Changes table, with a link to open it in History.

**⌘K** opens the command palette (`CommandDialog`, the console's `commandPalette.tsx`): flags, entities (with their
dimension and parent), pages, Settings' pages and a few actions.

## Pages

**A dense page** (every list):

- **`PageBar`:** sticky, 56px. The title (`h1`, 15px) and count on the left, search and `FilterSelect` chips in the
  middle, the page's actions on the right (one primary). Filters that need room get a row of their own under it.
- **Views** of the same thing are `Tabs` under the bar, in the address.
- **Table:** full width. `tableHeadClass` (sticky under the bar), `tableRowClass` (44px rows; a selected row is
  washed, `data-selected`; the keyboard's row has a 2px inset line, `data-active`). `RowCheck` and `useSelection`,
  `SortHeader` on sortable columns, `KeyHints` and the pager under it. A row's click is a shortcut for its main
  button or link, which keyboard and screen-reader users use. Selection is never `aria-selected` on a table row.
- **`BulkBar`:** sticks to the bottom while rows are selected: the count, the actions, Clear.
- **`Drawer`:** one record over the list (Esc closes, the list keeps its place); "Open …" goes to its full page.
- **Filters in the address** where people share them (History), and remembered as the default for next time.

**A record's page** (a flag, a release, an entity, a request) shows only that record and opens on its main work.

- **The way back is a crumb**, the one pattern on every detail page: the list's name, then `/`, then the record
  (`PageBar crumbs`, `crumbLink`): "Releases / new_checkout", "Stores / Acme / Acme 12", "Approvals / #42". It goes
  to the list as you left it. Pages with their own menu (Settings) have no crumb: the menu says where you are.
- Then the scope (the Environment chip), the state and the one primary action; tabs directly under it.

**Settings** has its own menu on the left (Environments, Dimensions, People, Single sign-on, Appearance, CDN), and
each page's bar names that page.

## Components

| Pattern | Component |
| --- | --- |
| Buttons: 32px, 13px sans, medium, sentence case, in any container; only color tells them apart | `Button` `default` (accent), `secondary`, `outline`, `stop` (red, destructive), `ghost`, `link` |
| A disabled button that says why: pass `title`. It stays reachable with Tab, shows the reason on hover and focus, and screen readers hear it | `Button disabled title="…"` |
| Views of one thing, under the bar | `Tabs` (with `panelId` for the panel's id) |
| Pick one of a few: mono cells, the chosen one inverted | `Segmented` |
| A word in a 1px box: kinds, states, environments | `Badge`, `StatusMark` |
| A note set off by a line on its left | `Callout` (`note`, `warn`, `error`) |
| Search with the magnifier | `SearchField` |
| Section label in mono caps with a hairline | `SectionLabel` |
| A short explanation on hover and focus; "?" next to a term | `Tooltip`, `HelpTip` |
| Toasts at the bottom right of the main pane | `Toaster`, `notify` |
| Command palette | `CommandDialog`, `CommandInput`, `CommandList`, `CommandGroup`, `CommandItem` |

## Keyboard, focus and motion

- **Every control shows focus:** a 1px ink outline, 2px outside the control (`outline-offset-2`), so it shows on an
  inverted or accent-filled control too. Never the accent.
- **Going to another page** puts focus on its title (the page bar's `h1`, `data-page-title`) and says the page's name
  to screen readers, unless focus is still somewhere on screen (the sidebar, a dialog) or the page put it somewhere.
- **Lists:** `useListKeys` works only while focus is in the table: ↑/↓ (or j/k) move and put focus on the row's
  button, x selects, Enter opens, Esc clears. Anywhere else the keys are the page's, so the arrows scroll.
- **Single-key shortcuts** (j, k, x, /) can be turned off in the account menu or the palette (`lib/shortcuts.ts`,
  WCAG 2.1.4). `KeyHints` then shows only the keys that still work.
- **Roles keep their promises.** Tabs and radio groups have one Tab stop and the arrow keys (`roving.ts`). A tree of
  entities is a plain table whose rows open with a button (`aria-expanded`). Buttons that stay pressed use
  `aria-pressed`, not radio roles.
- **Motion:** 150ms ease-out for hover and state, 200ms for what enters (drawer, toast). With reduced motion asked for,
  nothing slides or zooms: the drawer, toasts, dialogs and menus fade in place.
- **Forced colors:** the active row, selected rows, the selected tab and the current page get a system outline.
- **Lint:** oxlint's jsx-a11y rules run in `pnpm check` (`.oxlintrc.json`).

## Feedback

- **Toasts stack**, up to three, the newest at the bottom. One with an action (Undo, Retry, View) is never pushed out
  by the next; plain notices go first. Undo stays 20 seconds, errors 10 seconds and are red and announced at once.
  Every toast stays while the pointer or focus is on it.
- **Forgiveness.** Reversible actions happen at once and offer Undo. Irreversible, production or reviewed actions ask
  first, and the question says what will happen.
- **Errors** say what happened and the next step: someone else changed it → Reload; no server → Reload; a partial
  failure → Retry.
- **Loading:** the first load shows placeholder rows in the table's own grid; later reloads keep the old rows, dimmed.
- **Empty states** say why the list is empty and offer one next action (`Empty`).
- **One strip under the bar** at most (a protected environment, the draft bar). The installation's notice
  (Settings → Appearance) sits above the title bar, left-aligned, ink on a light wash with its tone as a left edge.

## Words

Short, plain sentences. Say what happened to what, how many and where: "Turned off 3 flags in development". Buttons
are verbs. Times are relative, with the exact time on hover. No fixed business words: the installation names its
dimensions (`GLOSSARY.md`).

## Checklist for a new list page

1. `PageBar` with title and count, search (`/`), `FilterSelect` chips for what people narrow by, one primary action.
2. A table with `tableHeadClass` and `tableRowClass`; each row has a real button or link as its way in.
3. Placeholder rows on the first load; old rows dimmed on reloads; an empty state with one action.
4. `useListKeys`, `useSelection`, `RowCheck`, `BulkBar`; `KeyHints` without what the page doesn't have.
5. A `Drawer` for one record; `initialFocus` on its first field when it holds a form.
6. Filters remembered (`usePersistentState`), and in the address when people share them.
7. Toasts name the object, count and place; reversible actions offer Undo, partial failures Retry.
8. Disabled buttons say why (`title` on `Button`).

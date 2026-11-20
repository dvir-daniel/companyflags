# Console design rules

The look of the CompanyFlags console.
`src/styles.css` holds these values as tokens; the components in `src/components` apply them.
Change a rule here and in the tokens, and every app picks it up on its next build.

The visual language follows better-auth.com (home page and docs).

## Themes

Two themes, both measured from better-auth.com: **dark** (pure black) and **light** (white). A person picks
Light or Dark (two choices, no System) with `ThemeToggle` in the title bar; `src/lib/theme.ts` keeps the choice and sets
`<html data-theme="light|dark">`. Components use tokens only (`bg-background`, `text-ink`, `border-rule`,
`bg-ink text-background` for inverted blocks), never a fixed black or white, so they read in both.

| | Dark | Light |
| --- | --- | --- |
| Page | #000 | #FFF |
| Panels | #0A0A0A, #121212 | #FAFAFA, #F5F5F5 |
| Text | #FAFAFA; nav at 65%; muted #A3A3A3, #808080 | #0A0A0A; nav at 60%; muted #525252, #737373 |
| Lines | #262626, #363636; rows at 8% white | #E5E5E5, #D4D4D4; rows at 8% black |
| Primary | white, black text | #0A0A0A, white text |
| Meaning colors | red #FF5A4E, amber #E8B864, green #7EE0A8, purple #B48CF5 | red #DC2626, amber #B45309, green #15803D, purple #7C3AED |

## Color

- Dark: pure black (#000), panels #0A0A0A, grid lines #262626. Text #FAFAFA, nav text at 65% white, muted #A3A3A3 and #808080. Light mirrors it (table above).
- **Text is readable.** All text, placeholders included, is at least 4.5:1 on its background (WCAG AA), and icons at least 3:1:
  the quietest text is `text-ink-3`, and dimmed text is `text-ink-nav`, never `text-ink/50`. `text-ink-4` is for decoration only
  (slashes, carets, underlines), never for words or icons people need to read.
- **Color only for meaning:**
  - each person's own color (attribution);
  - red for live: recording, production, problems, destructive actions;
  - amber for warnings and things waiting on someone;
  - green for on and done;
  - purple (#B48CF5) for agent tool calls.
- There is no brand color. The primary is the text color: white in dark, near-black in light.

## Type

- Geist for text, Geist Mono for labels, times, counts, keys and code.
- Page titles 28px semibold; subtitles 16–18px #999 with key phrases in white medium (`PageHeader`, `Hi`).
- Type scale 11 / 12 / 13 / 14 / 15 / 16 / 18 / 28 px; weights 400 / 500 / 600 only (emphasis is 500); line height 1.5.

## Shape

- Square corners everywhere, 1px lines. Status marks are squares, not dots.
- Panes sit edge to edge, divided by lines, not floating cards. Small "+" marks where grid lines meet (`crosshairs`).
- Cell and row lines at 8% white, nav dividers at 6% white, section rules #262626.

## Patterns

| Pattern | Component |
| --- | --- |
| Window: 44px title bar, 232px sidebar, scrolling main pane, 34px mono footer | `AppFrame`, `TitleBar`, `Sidebar`, `MainPane`, `Footer` |
| Docs-style sidebar: search with ⌘K, items with icons, the active item on a faint white background | `SidebarSearch`, `SidebarLabel`, `SidebarItem` / `sidebarItemClass`, `SidebarCount` |
| Section labels in mono caps followed by a hairline rule | `SectionLabel` |
| White primary buttons; small uppercase ghost buttons for secondary actions | `Button` (`default`, `secondary`, `outline`) |
| Destructive and stop actions in a red outline | `Button variant="stop"` |
| Underlined tabs | `Tabs` |
| Pick one of a few: mono cells, the chosen one inverted | `Segmented` |
| Labels in a 1px box (kinds, states, environments; purple `agent` for what an AI agent did) | `Badge` |
| A note set off by a line on its left | `Callout` |
| Search with the magnifier | `SearchField` |
| Rounded pills only for announcements and phase tags | `Pill` |
| Inverted white toast at the bottom right of the main pane, one at a time | `Toaster`, `notify` |
| Dithered pixel texture as decoration | `dither`, `dither-fill` |
| A mono footer with slashes | `Footer`, `FooterSlash` |
| Light / dark | `ThemeToggle`, `useTheme`, `initTheme`, `themeBootScript` |
| Phone (under 768px): no sidebar or footer; a bottom tab bar with the 4 most-used pages and More, which opens the whole sidebar in a `Drawer`. The tab bar reserves its height, so toasts stay above it | the console's `MobileNav` (web/src/shell.tsx), `useBottomReserve` |
| Dense data pages: page bar, filter chips, sortable tables, bulk actions, drawer | `PageBar`, `FilterSelect`, `SortHeader`, `useSelection`, `useListKeys`, `BulkBar`, `Drawer` (see "Dense console") |
| Prototype-only controls are dashed and labeled "Demo" | `Button variant="demo"`, `demoControlClass`, `DemoTag` |

## Measured values to keep

- Every bar is 44px tall; 16px left gutter everywhere; cell padding 20px.
- Active nav cell or tab: 2px underline at 60% white. Nav labels Geist Mono 12px uppercase, 0.6px letter-spacing.
- Inputs 38px tall (32px in dense editors), primary buttons 32px, ghost buttons 27px.

## Recipes

How the console builds its screens, as Tailwind classes. Build new pages from these and the components;
an app needs no stylesheet of its own beyond its entry file.

**Page.** A column in `MainPane` (860px, or `wide` 1080px for tables). Title and subtitle with `PageHeader`
(28px semibold, 18px `text-subtitle`, key phrases in `Hi`). Below it, the page's main control, then sections.

```tsx
<PageHeader title="API keys">Each key belongs to <Hi>one environment and one app</Hi>.</PageHeader>
```

**Section label.** `SectionLabel`: mono 13px caps with a hairline to the right. Sections are 40px apart (`mt-10`).

**Setting or property row.** A name and one sentence on the left, one control on the right, rows divided by 8% lines:
`grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-6 border-b border-grid py-3`;
name `text-sm font-medium`, sentence `text-13 text-ink-2`.

**List.** `<ul>` with rows `border-b border-grid py-3` (or `py-2.5 text-13` when dense). A row's meta line:
`flex flex-wrap items-baseline gap-x-2.5 text-13 text-ink-2`, its time or kind at the end
`ml-auto font-mono text-11 text-ink-3 uppercase`. Rows that open something: `hover:bg-wash`, no border change.
Column heads (when a list has columns): `font-mono text-11 text-ink-3 uppercase`, on a `border-b border-rule` row.
Secondary actions on a row appear on hover: `opacity-0 group-hover:opacity-100 focus-visible:opacity-100`.

**Stacked cells.** Cards are cells of one grid, edge to edge: wrap in `crosshairs` and give each
`-mt-px border border-grid p-5 hover:bg-ink/[.015]`. Side by side: `grid grid-cols-2 gap-px border border-grid bg-grid`
with each cell `bg-background px-5 py-4`.

**Toolbar above a list.** `flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-rule pb-3`: underlined
`Tabs` or a `Segmented`, a count (`text-15 font-medium`), `flex-1`, then filters.

**Search.** `SearchField size="lg"` as a page's main search, `size="sm"` above a list.

**Filter and suggestion chips.** `cursor-default border border-rule bg-transparent px-[11px] py-[5px] text-13 text-ink-2 hover:border-rule-2 hover:text-ink`;
pressed: `aria-pressed:border-ink aria-pressed:text-ink`.

**Tags.** A word in a 1px box: `border border-rule-2 px-[7px] font-mono text-11 text-ink-2` (or `Badge`).
Values, keys and code: `font-mono`; a value in a box: `border border-rule bg-panel px-1.5 font-mono text-13`.

**Fields.** `Input` (38px) in forms and dialogs; in dense rows `Input className="h-8 text-13"` and `NativeSelect size="sm"`.
Labels above fields: `font-mono text-11 text-ink-3 uppercase`; help below: `text-13 text-ink-3`.

**Notes.** `Callout`: `note` (grey line), `warn` (amber), `error` (red).

**Links.** `text-13 text-ink underline decoration-ink-4 underline-offset-4 hover:decoration-ink` (`Button variant="link"`).

**Saving.** A change applies at once and the toast offers Undo (`notify(message, { label: "Undo", onClick })`).
Where a change needs a review first, collect it and show what will change before it is sent.

**Empty and loading.** `Empty` with one sentence and, when there is one, the action that fills it.
Loading: a sentence in `text-13 text-ink-3`, or a block `h-… bg-panel animate-pulse`.

## Dense console (data pages)

For pages that manage many records (flags, customers, requests, keys, logs), the Stripe / Linear model:

- **`MainPane fluid`:** the page gets the full width and owns its padding (`px-6`). Root: `flex min-h-full flex-col`.
- **`PageBar`:** sticky, 56px. Title and count on the left (crumbs before the title on a detail page), search (`/` focuses it) and `FilterSelect` chips in the middle, the page's actions on the right (one primary).
- **Table:** full width under the bar. `tableHeadClass` (sticky under the bar) and `tableRowClass` (44px rows, washed when selected; the keyboard's row gets a 2px inset line). A checkbox column with `RowCheck` and `useSelection`, `SortHeader` on sortable columns, `KeyHints` and the pager under it.
- **Keyboard:** `useListKeys`: j/k or ↑/↓ move, x selects, Enter opens, Esc clears.
- **`BulkBar`:** sticks to the bottom while rows are selected: the count, the actions for them (one call each, a summary toast, errors per row), Clear.
- **`Drawer`:** row click or Enter opens the record over the list (Esc closes, the list keeps its place). A quick view and the main actions; "Open …" goes to the full page.
- **No decoration:** no pills, no sentences restating the screen. Every element filters, shows data, or acts.

## Rules of harmony and human resonance

Every screen is checked against these. Each rule names what enforces it, so it holds by default.

### Harmony (how it looks together)

| Rule | What it means here | Enforced by |
| --- | --- | --- |
| **One rhythm** | Spacing in 4px steps; 24px page gutters (`px-6`) so the bar, banners and tables share one left edge. | `PageBar`, `tableHeadClass`, `tableRowClass`, `BulkBar` all use `px-6` |
| **One control height per context** | 32px for every control in a bar or a dense row, 38px in forms and dialogs; bars are 44, 48 or 56px. Nothing in a row is taller than its neighbours. | `PageBar`, `BulkBar` (they set their buttons to 32px), `FilterSelect`, `SearchField`, `NativeSelect size="sm"` |
| **Modular type** | 11 / 12 / 13 / 14 / 15 / 16 / 18 / 28; weights 400 / 500 / 600. Mono for keys, values, counts and labels; sans for prose. | the Tailwind theme in `styles.css` |
| **Calm color** | Neutrals carry the layout; color only means state: green on, red production / off / destructive, amber waiting / protected, purple agents. | tokens; `Badge`, `StatusMark`, `Callout` |
| **Consistent motion** | 150ms ease-out for hover and state, 200ms for things that enter (drawer, toast); nothing moves when the person asked for reduced motion. | `tableRowClass`, `FilterSelect`, `Drawer`, `Toast`; `prefers-reduced-motion` |
| **Gestalt: proximity and common region** | Things that work together sit together: search and filters in one group, the page's actions in another; a record's actions live in its drawer footer. | `PageBar` (filters middle, actions right), `Drawer` footer |
| **Gestalt: similarity** | Same job, same look: every filter is a `FilterSelect`, every list is the same table, every detail is a `Drawer`. | the dense-console components |

### Human resonance (how it feels to use)

| Rule | What it means here | Enforced by |
| --- | --- | --- |
| **Doherty threshold** | Feedback within 400ms. Switches move the moment they're clicked and move back if the server says no (optimistic). The first load shows placeholder rows in the table's own grid; later reloads keep the old rows, dimmed. Clicks open the drawer at once. Long bulk runs report progress ("Turning off 3 of 12…"). | `TableSkeleton`, list `aria-busy` + opacity, `Drawer`, `BulkBar`; the console's `PowerSwitch` |
| **Forgiveness** | Reversible actions happen at once and offer **Undo** in the toast (it stays 10s). Only irreversible, production or reviewed actions ask first, and the question says what will happen. A bulk run that partly fails offers **Retry** for just the failed ones. | `notify(message, { label: "Undo" \| "Retry", onClick })`; the app's `ask` dialog |
| **Memory** | A page opens the way you left it: filters, sort, the last environment, the last comparison. The search starts empty. Sets of filters people come back to are saved as named views. | `usePersistentState` (the console's `ui.tsx`); `ViewMenu` |
| **Plain language** | Say what happened to what, how many, and where: "Turned off 3 flags in development". Buttons are verbs. Times are relative, with the exact time on hover. | toast copy; `When` |
| **Hick's law** | One primary action per page; filters only for what people actually narrow by; rare actions in the drawer, not the list. | `PageBar` actions, `Drawer` |
| **Fitts's law** | Big targets for frequent actions: whole rows open, the checkbox has a full column, the primary action sits where the eye ends (top right, bottom bar). | `tableRowClass`, `RowCheck`, `PageBar`, `BulkBar` |
| **Jakob's law** | Behave like the tools people already use: ⌘K / `/` to search, j/k to move, x to select, Enter to open, Esc to close. | `useListKeys`, `KeyHints`, the app's ⌘K |
| **Von Restorff** | The one thing that matters stands out: production is amber and locked, problems red, the waiting count amber; everything else stays quiet. | tokens; protected banners; `Badge` |
| **Zeigarnik** | Unfinished work stays visible until it's done: unpublished changes, requests waiting for you, selections. | the draft bar, the sidebar count, `BulkBar` |
| **Peak-end** | Finishing feels finished: the toast confirms what happened and offers the next step ("View", "Undo"). | toasts with an action |
| **Tesler's law** | The system carries the complexity: keys made from names, the environment remembered, production changes routed to review by themselves. | server rules; `usePersistentState` |
| **Postel's law** | Accept loose input: search ignores case and spacing, keys are slugged as you type. | `searchHit`; the console's forms |
| **Miller's law** | Chunk what people read: 50 rows a page, related fields grouped, long lists of conditions cut to two lines with the rest on hover. | `Pager`, forms, the rule rows |
| **Goal-gradient** | Show how close something is to done, so people finish it: a request shows "1 of 2 approvals" with a segment per approval. | the approvals list and drawer |
| **Serial position** | What matters most goes first and last: the record's name is the first column, when it changed is the last; the primary action is the last thing in the bar. | column order; `PageBar` actions |
| **Selective attention** | People skip anything that looks like a banner. Only one strip may sit under the bar (a protected environment), it's one line, and it never carries an action. | page strips |
| **Uniform connectedness** | Things joined by a line or a shared background belong together: a bar's controls share its border; a row's cells share its hover wash. | `PageBar`, `tableRowClass` |
| **Paradox of the active user** | Nobody reads the manual, so the answer sits next to the term: a small "?" on jargon (column heads, a flag's purpose), one or two plain sentences. | `HelpTip`, `SortHeader help`, `ColumnHead help` |

### Heuristics (Nielsen) that aren't covered above

| Rule | What it means here | Enforced by |
| --- | --- | --- |
| **Visibility of system status** | Something is always happening on screen while you wait: skeleton rows, dimmed rows, progress text, the "Synced" mark in the footer. | `TableSkeleton`, `BulkBar`, the app footer |
| **Recognize, diagnose, recover from errors** | An error says what happened in a sentence and offers the next step: someone else changed it → **Reload**; the server can't be reached → **Reload**; a partial failure → **Retry**. Errors stay 10s and are red. | the console's `toast(message, "err")` |
| **Recognition rather than recall** | Filters show their value on the chip; the drawer shows a record without leaving the list; the empty state names the filters that hid everything. | `FilterSelect`, `Drawer`, empty states |
| **Help users with empty states** | An empty list says why it's empty (which filters, or that nothing exists yet and what it's for) and offers exactly one next action. | the console's `Empty` |

### Checklist for a new list page

1. `PageBar` with title and count, search (`/`), `FilterSelect` chips for what people actually narrow by, `ViewMenu` once there are two or more filters, one primary action.
2. A table with `tableHeadClass` and `tableRowClass`, `SortHeader` on the columns the server can sort, `HelpTip` on any term a new teammate would ask about.
3. `TableSkeleton` on the first load; old rows dimmed on reloads; an empty state with one action.
4. `useListKeys`, `useSelection`, `RowCheck`, `BulkBar`; `KeyHints` without the shortcuts the page doesn't have.
5. A `Drawer` for one record; `initialFocus` on its first field when it holds a form.
6. Filters and sort through `usePersistentState`; times through `When`.
7. Toasts name the object, count and place; reversible actions offer Undo, partial failures Retry.

### Detail pages: one record, full width (Google)

Opening a record shows only that record and opens straight on its main work (a flag opens on its rules), the
way Google's editors do. No overview or summary that repeats what the header, Settings or History already show.

1. **Header row** (`PageBar`): a back arrow (to the list as you left it), the name (mono for keys) with a
   copy icon, the scope (Environment chip, whose menu shows each environment's state), the state and the one
   primary action (Turn off).
2. **Tabs directly under it**: the editor first, then the rest (Variants, History, Settings, Debug).

Unpublished edits pin a bar to the bottom of the pane (`useBottomReserve`, so toasts stay above it).

### Drafts and versions (the Flags page)

Edits don't go live one by one: they collect in **your draft** (per person and environment, kept in the
browser, so leaving a page never loses them) and are published together as **one numbered version** of the
environment, or as one review request where the environment needs approval. The page shows it in this order:
the bar (environment, "Publish changes (N)" while a draft exists), the tabs (Flags · Versions · Conditions),
the draft bar (what's waiting, Review, Discard with Undo), the filters, the table (a column per environment,
"In your draft" on edited rows). A draft remembers the settings it was made against, so publishing after
someone else's change is refused rather than overwriting it. Any earlier version can be restored; the
rollback is itself a new version, so it can be undone the same way. The on/off switch is the exception: it
acts at once (with Undo), because a kill switch can't wait for a publish.

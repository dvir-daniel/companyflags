# @companyflags/ui

The look of the CompanyFlags console: design tokens for the light and dark themes, the Tailwind theme, and the
components (shadcn on Base UI, Phosphor icons). The rules behind it are in [DESIGN.md](DESIGN.md).

- `src/styles.css`: tokens, the Tailwind theme, base styles, fonts (Geist, Geist Mono) and utilities.
- `src/lib/theme.ts`: Light or Dark, saved per person (`initTheme`, `useTheme`, `themeBootScript`).
- `src/components/`: the components, plus the console window (`AppFrame`, `TitleBar`, `Sidebar`, `MainPane`,
  `Footer`), `PageHeader`, `Badge`, `Segmented`, `Tabs`, `NativeSelect`.
- `src/lib/utils.ts`: `cn`, which knows the type scale (`text-11`, `text-13`, `text-15`, `text-28`).

It is private to this repository and has no build step: the console (`web/`) compiles the source with its own Vite and
TypeScript, and uses its own copies of the peer dependencies, so there is only ever one React.

```ts
import { Button } from '@companyflags/ui/components/button';   // one file at a time (keeps Fast Refresh precise)
import { cn } from '@companyflags/ui/lib/utils';
```

```css
@import "tailwindcss";
@import "@companyflags/ui/styles.css";
```

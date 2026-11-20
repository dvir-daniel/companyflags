---
title: "Appearance"
---

Each server can show its own name, logo and colors, in the console and on the sign-in page. An admin sets them in
**Settings → Appearance**. You can also set them in the config file, where they can't be changed from the console.

## What you can set

| Setting | Where it shows |
|---|---|
| **Name** | The title bar, the browser tab and the sign-in page ("Join Acme Flags"). If empty: CompanyFlags. |
| **Logo** | Before the name in the title bar and on the sign-in page, 20 pixels high. If you set a logo and no name, the logo shows alone. |
| **Logo on dark** | Used instead of the logo in the dark look, for a logo that doesn't read on black. |
| **Browser tab icon** | The favicon. |
| **Accent** | Buttons, switches, the selected page in the sidebar and focus rings. Pick none (black and white), one of seven colors, or your own. |
| **Light or dark** | The look for people who haven't chosen one. Anyone can still switch in the title bar. |
| **Notice** | A line across the top of every page, for people signed in: a release freeze, planned work, where to ask. It can be information, a warning or important. |
| **Sign-in note** | Under the sign-in form: who may sign in, or that use is logged. |
| **Help link** | "Get help" on the sign-in page, in the account menu and in the footer. It can be a web address or a `mailto:` address. |
| **Footer links** | Up to four: privacy, terms of use, an internal page. |

- **Images:** PNG, SVG, WebP, JPEG, GIF or ICO, up to 200 KB each. The icon can be up to 50 KB. They're kept in the
  database, so the console needs no file storage and works with no internet access.
- **Links:** must start with `https://` or `mailto:`.
- **Contrast:** the form warns when an accent is hard to see on the light or the dark page. Text on the accent is
  black or white, whichever reads better.
- **Live preview:** while the form is open, the page shows the accent and the look you picked. Cancel puts them back.
- **History:** every change is recorded under **Appearance**. History keeps a short hash of each image, never the
  image itself.
- **Reset:** **Back to default** removes everything.

## In the config file

Set `appearance` in `companyflags.config.ts` to keep the look in Git, the same on every server. Settings then shows
it read-only. Images are files beside the config file, or data URLs:

```ts
// companyflags.config.ts
import { defineConfig } from 'companyflags/config';

export default defineConfig({
  appearance: {
    name: 'Acme Flags',
    logo: './brand/logo.svg',
    logoDark: './brand/logo-white.svg',
    icon: './brand/icon.png',
    accent: 'custom',               // none, blue, indigo, violet, teal, green, orange, rose or custom
    accentColor: '#0f766e',         // for custom
    mode: 'device',                 // device, light or dark
    banner: { text: 'Production changes need two approvals.', tone: 'info' },   // info, warn or danger
    signInNote: 'For Acme Corp staff only. Sign in with your work account.',
    helpUrl: 'https://wiki.acme.example/flags',
    links: [{ label: 'Privacy', url: 'https://acme.example/privacy' }],
  },
});
```

The server checks the settings when it starts. If one is wrong, the server stops and says which one.

## How it works

- `GET /api/appearance` gives the name, the image addresses, the accent, the look, the sign-in note and the links. It
  is open before sign-in, because the sign-in page needs it. The notice is in `/api/meta`, for people signed in only.
- The images are served at `/api/appearance/images/logo`, `logo-dark` and `icon`. Each address carries the image's
  hash, so browsers can cache it for good. They're served with a policy that runs nothing (`sandbox`), so an SVG
  opened on its own can't run a script.
- The server puts the name, the icon, the accent's colors and the default look into the console's page before it
  sends it. So the first paint already looks right, with no flash of the default look.
- Admins change it with `PUT /api/appearance`, and `DELETE /api/appearance` goes back to the default. An admin's
  [access token](/guide/security#access-tokens) works too.

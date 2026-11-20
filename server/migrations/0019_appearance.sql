-- Migration 0019: how the console looks for this installation (Settings → Appearance, server/appearance.ts): its name,
-- logo and icon, an accent color, the default light or dark, a notice, a sign-in note, a help link and footer links.
--
-- One row at most. The settings are checked by the server (appearance.ts checkAppearance) and kept as JSON; the images
-- are data URLs in it (each 200 KB at most), so the console needs no file storage and works with no internet.
create table appearance (
  id boolean primary key default true check (id),
  settings jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text not null
);

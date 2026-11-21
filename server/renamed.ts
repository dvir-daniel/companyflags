// Settings with new names. A server started with an old name, and not its new one, refuses to start: it would
// otherwise run without the secret or the address it was given. The upgrade note is in CHANGELOG.md.
// The sign-in library also reads names of its own from the environment. They are taken out of process.env before it
// starts (accounts.ts createAuth), so it uses only what this server hands it.

/** Old name → new name. */
export const RENAMED: Readonly<Record<string, string>> = {
  BETTER_AUTH_SECRET: 'FF_SECRET',
  BETTER_AUTH_URL: 'FF_PUBLIC_URL',
  BETTER_AUTH_TRUSTED_ORIGINS: 'FF_TRUSTED_ORIGINS',
};

/** What to rename, when an old name is set and its new one isn't; otherwise null. */
export function renamedProblem(env: NodeJS.ProcessEnv): string | null {
  for (const [old, now] of Object.entries(RENAMED)) {
    if (env[old] && !env[now]) return `${old} is now ${now}: rename it in your environment`;
  }
  return null;
}

// The names the sign-in library reads on its own: its secret(s), its address, its trusted origins, its telemetry.
// The server passes the secret, the address and the origins itself, and turns telemetry off.
const LIBRARY_NAMES = /BETTER_AUTH_|^AUTH_SECRET$|^NUXT_PUBLIC_AUTH_URL$/;

/** Takes the sign-in library's own names out of the environment, so it can't read them behind the server's back. */
export function hideLibrarySettings(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of Object.keys(env)) if (LIBRARY_NAMES.test(name)) delete env[name];
}

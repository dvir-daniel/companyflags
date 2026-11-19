// What the sign-in pages need besides components (signinFrame.tsx, signin.tsx, main.tsx): what this browser remembers
// about signing in, and the server's sign-in options. Apart from the components so that an edit to them swaps in place
// in `pnpm dev` (React Fast Refresh); an edit here reloads the page.
import { readPersistent, writePersistent } from './persist.ts';

export type Provider = 'google' | 'github' | 'microsoft';
export type SignInInfo = { kind: string; providers: Provider[]; firstPerson: boolean; sso: boolean };

/** Whether the person was signed in the last time this browser opened the console (null: this browser hasn't
 *  seen it yet). The first load draws the console's frame or the sign-in page from it, before the server says; with
 *  null it draws neither, so nobody who is signed in is shown a sign-in form. */
export const lastSignedIn = () => readPersistent<boolean | null>('signedIn', null);
export const rememberSignedIn = (on: boolean) => { if (lastSignedIn() !== on) writePersistent('signedIn', on); };

// What the sign-in page shows (the ways to sign in), asked for once per visit and remembered in this browser: it's the
// same for everyone on this server, and the page opens with the remembered answer while a fresh one loads.
let asked: Promise<SignInInfo> | null = null;
/** The server's sign-in options, fetched once (main.tsx starts it while the sign-in code downloads). */
export function signInInfo(): Promise<SignInInfo> {
  asked ??= fetch('/api/sign-in').then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    // "nobody has an account yet" is true once per server, so it isn't remembered: the next visit would draw it wrongly
    .then((info: SignInInfo) => { writePersistent('signin.info', { ...info, firstPerson: false }); return info; });
  asked.catch(() => { asked = null; });
  return asked;
}
/** The last answer of signInInfo in this browser, if there was one. */
export const lastSignInInfo = () => readPersistent<SignInInfo | null>('signin.info', null);

/** The fields' look on these pages: a little taller, on a faint fill. */
export const field = 'h-10 bg-wash text-sm';

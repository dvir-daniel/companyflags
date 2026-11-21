// The sign-in library's client, for signing in (signin.tsx) and out (session.ts loads this only when someone signs out).
// Apart from signin.tsx so that an edit to its components swaps in place in `pnpm dev` (React Fast Refresh).
import { createAuthClient } from 'better-auth/client';
import { ssoClient } from '@better-auth/sso/client';
import { rememberSignedIn } from './signinKit.ts';

export const authClient = createAuthClient({ basePath: '/api/auth', plugins: [ssoClient({ domainVerification: { enabled: true } })] });

/** Ends this browser's session and goes back to the sign-in page. */
export async function signOut() {
  await authClient.signOut().catch(() => {});
  rememberSignedIn(false);
  location.hash = '#/flags';
  location.reload();
}

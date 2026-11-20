// What two-factor sign-in needs besides its components (twoFactor.tsx, signin.tsx): Better Auth's two-factor endpoints
// (server/betterAuth.ts, its twoFactor plugin), and the setup key an authenticator app takes. Apart from the
// components so an edit to them swaps in place in `pnpm dev` (React Fast Refresh).

/** Your own account (GET /api/account): whether you have a password, and whether two-factor sign-in is on. */
export type Account = { password: boolean; twoFactor: boolean };

/** What turning two-factor on gives: the authenticator app's address (otpauth://) and the recovery codes, shown once. */
export type Enabled = { totpURI: string; backupCodes: string[] };

/** One of Better Auth's two-factor endpoints (/api/auth/two-factor/…). A refusal throws its message. */
export async function twoFactorCall<T = unknown>(path: string, body: Record<string, unknown>): Promise<T> {
  const r = await fetch(`/api/auth/two-factor/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body),
  });
  const text = await r.text();
  const json = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error(TWO_FACTOR_REFUSED[json?.code] ?? json?.message ?? `HTTP ${r.status}`);
  return json as T;
}

/** What a refused code or password says, in our words. */
export const TWO_FACTOR_REFUSED: Record<string, string> = {
  INVALID_CODE: 'That code doesn’t match. Check the time on your phone, then try the newest code.',
  INVALID_BACKUP_CODE: 'That recovery code doesn’t work: it may have been used.',
  INVALID_PASSWORD: 'That password isn’t right.',
  INVALID_TWO_FACTOR_COOKIE: 'This sign-in took too long. Start again with your password.',
  TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: 'Too many tries. Start again with your password.',
  ACCOUNT_TEMPORARILY_LOCKED: 'Too many wrong codes: try again in 15 minutes.',
};

/** The setup key in an authenticator app's address, in groups of four: what you type when you can't scan. */
export function setupKey(uri: string): string {
  try {
    return (new URL(uri).searchParams.get('secret') ?? '').match(/.{1,4}/g)?.join(' ') ?? '';
  } catch {
    return '';
  }
}

/** A code as typed: digits only, six of them for an authenticator app. */
export const codeOf = (typed: string) => typed.replace(/\s+/g, '');
export const isAppCode = (typed: string) => /^\d{6}$/.test(codeOf(typed));

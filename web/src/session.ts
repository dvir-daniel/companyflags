// Signing out without loading the sign-in code (the sign-in library's client) for everyone who is signed in:
// it's fetched only when someone actually signs out.
export async function signOut() {
  const { signOut: run } = await import('./authClient.ts');
  await run();
}

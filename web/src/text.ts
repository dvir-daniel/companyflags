// Small wording helpers shared by every page.

/** "1 flag", "2,048 flags", "3 people" (pass the plural when it isn't just "+s"). */
export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/**
 * What the first page says when the console can't start (GET /meta failed, main.tsx), from the answer's status: 0 when
 * nothing answered, 403 for someone without access, and any other status when the server answered with an error (a
 * 500, a proxy's 502, a failed migration). `message` is the error's own words.
 */
export function bootProblem(status: number, message: string): { title: string; text: string } {
  if (status === 403) return { title: 'You don’t have access.', text: `${message.charAt(0).toUpperCase()}${message.slice(1)}.` };
  if (status === 0) return { title: 'Can’t reach the CompanyFlags server.', text: `Check that it’s running, then reload. (${message})` };
  const said = message && message !== `HTTP ${status}` ? `HTTP ${status}: ${message}` : `HTTP ${status}`;
  return { title: 'The CompanyFlags server answered with an error.', text: `${said}. Reload, or check the server’s log.` };
}
